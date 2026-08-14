import { Router, type NextFunction, type Request, type Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import pool from "../db/connection";
import {
  assertEntraConfigured,
  EntraConfigError,
  EntraTokenError,
  getEntraConfig,
  isEntraEnabled,
  verifyEntraAccessToken,
  type EntraIdentity,
} from "../auth/entra";
import {
  clearSessionCookie,
  createSession,
  revokeCurrentSession,
  revokeOtherSessions,
  setSessionCookie,
  type UserRole,
} from "../auth/session";
import { requireUserSession } from "../middleware/requireUserSession";
import { rateLimiter } from "../mcp/security/rateLimiter";

interface LoginUserRow extends RowDataPacket {
  id: number;
  username: string;
  role: UserRole;
  is_active: number;
  entra_oid: string | null;
}


const EntraLoginSchema = z.object({
  accessToken: z.string().min(20).max(16_384).optional(),
}).strict();

function safeUser(user: { id: number; username: string; role: UserRole }) {
  return { id: Number(user.id), username: user.username, role: user.role };
}

function isDuplicateEntry(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function countActiveAdmins(): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1",
  );
  return Number(rows[0]?.total || 0);
}

async function resolveUniqueUsername(base: string, excludeUserId?: number): Promise<string> {
  let candidate = base.slice(0, 100);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [candidate],
    );
    const existingId = rows[0]?.id == null ? undefined : Number(rows[0].id);
    if (existingId === undefined || existingId === excludeUserId) return candidate;
    const suffix = `_${attempt + 1}`;
    candidate = `${base.slice(0, Math.max(3, 100 - suffix.length))}${suffix}`;
  }
  throw new Error("Unable to allocate a unique local username for the Entra account.");
}

async function findOrCreateEntraUser(identity: EntraIdentity): Promise<LoginUserRow> {
  const [byOid] = await pool.query<LoginUserRow[]>(
    `SELECT id, username, role, is_active, entra_oid
       FROM users WHERE entra_oid = ? LIMIT 1`,
    [identity.oid],
  );
  if (byOid[0]) {
    if (!byOid[0].is_active) {
      throw new EntraTokenError("This account is disabled.");
    }
    return byOid[0];
  }

  const preferredKeys = [identity.preferredUsername, identity.email]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  const usernameCandidates = [...new Set([
    identity.username.toLowerCase(),
    ...preferredKeys,
  ])];
  if (usernameCandidates.length) {
    const placeholders = usernameCandidates.map(() => "?").join(", ");
    const [byUsername] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, role, is_active, entra_oid
         FROM users
        WHERE LOWER(username) IN (${placeholders})
        LIMIT 1`,
      usernameCandidates,
    );
    const match = byUsername[0];
    if (match && !match.entra_oid) {
      if (!match.is_active) {
        throw new EntraTokenError("This account is disabled.");
      }
      await pool.query(
        "UPDATE users SET entra_oid = ?, updated_by = id WHERE id = ?",
        [identity.oid, match.id],
      );
      match.entra_oid = identity.oid;
      return match;
    }
  }

  const role: UserRole = (await countActiveAdmins()) === 0
    ? "admin"
    : getEntraConfig().defaultRole;
  const username = await resolveUniqueUsername(identity.username);
  try {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (username, entra_oid, role, is_active)
       VALUES (?, ?, ?, 1)`,
      [username, identity.oid, role],
    );
    await pool.query(
      "UPDATE users SET created_by = id, updated_by = id WHERE id = ?",
      [result.insertId],
    );
    const [created] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, role, is_active, entra_oid
         FROM users WHERE id = ? LIMIT 1`,
      [result.insertId],
    );
    if (!created[0]) throw new Error("Failed to load the newly provisioned Entra user.");
    return created[0];
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [retry] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, role, is_active, entra_oid
         FROM users WHERE entra_oid = ? LIMIT 1`,
      [identity.oid],
    );
    if (retry[0]) return retry[0];
    throw error;
  }
}


async function entraLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    assertEntraConfigured();
    const parsed = EntraLoginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid Entra login request", code: "INVALID_ENTRA_LOGIN" });
      return;
    }
    const token = readBearerToken(req) || parsed.data.accessToken;
    if (!token) {
      res.status(401).json({
        error: "Missing Entra access token",
        code: "ENTRA_TOKEN_REQUIRED",
      });
      return;
    }

    const identity = await verifyEntraAccessToken(token);
    const user = await findOrCreateEntraUser(identity);
    await revokeCurrentSession(req);
    const session = await createSession(Number(user.id));
    setSessionCookie(res, session.token);
    res.json({ data: { user: safeUser(user), expiresAt: session.expiresAt.toISOString() } });
  } catch (error) {
    if (error instanceof EntraConfigError) {
      res.status(503).json({ error: error.message, code: "ENTRA_NOT_CONFIGURED" });
      return;
    }
    if (error instanceof EntraTokenError) {
      res.status(401).json({ error: error.message, code: "INVALID_ENTRA_TOKEN" });
      return;
    }
    next(error);
  }
}

async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await revokeCurrentSession(req);
    clearSessionCookie(res);
    res.json({ data: { loggedOut: true } });
  } catch (error) {
    next(error);
  }
}

function me(req: Request, res: Response): void {
  res.json({ data: { user: safeUser(req.user!) } });
}


let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (routerInstance) return routerInstance;
  const router = Router();
  router.post("/entra/login", rateLimiter({ maxPoints: 8, windowMs: 60_000 }), entraLogin);
  router.post("/logout", requireUserSession, logout);
  router.get("/me", requireUserSession, me);
  routerInstance = router;
  return router;
}
