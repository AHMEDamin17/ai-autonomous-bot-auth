# Complete Authentication Codebase Reference

This document compiles the entire backend and frontend authentication system for easy reference and architectural review.

---

## Table of Contents

### Backend Authentication & Sessions
1. [backend/src/auth/entra.ts](#1-backendsrcauthentrats)
2. [backend/src/auth/password.ts](#2-backendsrcauthpasswordts)
3. [backend/src/auth/session.ts](#3-backendsrcauthsessionts)
4. [backend/src/middleware/requireUserSession.ts](#4-backendsrcmiddlewarerequireusersessionts)
5. [backend/src/routes/auth.ts](#5-backendsrcroutesauthts)

### Frontend Authentication & MSAL
6. [frontend/src/auth/msalConfig.js](#6-frontendsrcauthmsalconfigjs)
7. [frontend/src/auth/AuthContext.jsx](#7-frontendsrcauthauthcontextjsx)
8. [frontend/src/auth/LoginGate.jsx](#8-frontendsrcauthlogingatejsx)

---

## Backend Authentication & Sessions

### 1. `backend/src/auth/entra.ts`

```typescript
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface EntraConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  authority: string;
  audience: string;
  defaultRole: "admin" | "user";
}

export interface EntraIdentity {
  oid: string;
  username: string;
  preferredUsername?: string;
  email?: string;
}

let jwksCache: { authority: string; jwks: ReturnType<typeof createRemoteJWKSet> } | undefined;

export function isEntraEnabled(): boolean {
  return String(process.env.AZURE_ENTRA_ENABLED || "").trim().toLowerCase() === "true";
}

export function getEntraConfig(): EntraConfig {
  const tenantId = String(process.env.AZURE_ENTRA_TENANT_ID || "").trim();
  const clientId = String(process.env.AZURE_ENTRA_CLIENT_ID || "").trim();
  const authorityRaw = String(process.env.AZURE_ENTRA_AUTHORITY || "").trim();
  const authority = (authorityRaw || (tenantId ? `https://login.microsoftonline.com/${tenantId}` : ""))
    .replace(/\/+$/, "");
  const audience = String(process.env.AZURE_ENTRA_AUDIENCE || "").trim() || clientId;
  const roleRaw = String(process.env.AZURE_ENTRA_DEFAULT_ROLE || "user").trim().toLowerCase();
  const defaultRole: "admin" | "user" = roleRaw === "admin" ? "admin" : "user";

  return {
    enabled: isEntraEnabled(),
    tenantId,
    clientId,
    authority,
    audience,
    defaultRole,
  };
}

export function assertEntraConfigured(config: EntraConfig = getEntraConfig()): void {
  if (!config.enabled) {
    throw new EntraConfigError("Azure Entra ID sign-in is disabled. Set AZURE_ENTRA_ENABLED=true.");
  }
  if (!config.clientId) {
    throw new EntraConfigError("AZURE_ENTRA_CLIENT_ID is required when Azure Entra ID is enabled.");
  }
  if (!config.authority) {
    throw new EntraConfigError(
      "AZURE_ENTRA_AUTHORITY or AZURE_ENTRA_TENANT_ID is required when Azure Entra ID is enabled.",
    );
  }
  if (!config.audience) {
    throw new EntraConfigError("AZURE_ENTRA_AUDIENCE or AZURE_ENTRA_CLIENT_ID is required for token validation.");
  }
}

export class EntraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraConfigError";
  }
}

export class EntraTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntraTokenError";
  }
}

function getJwks(authority: string) {
  if (!jwksCache || jwksCache.authority !== authority) {
    jwksCache = {
      authority,
      jwks: createRemoteJWKSet(new URL(`${authority}/discovery/v2.0/keys`)),
    };
  }
  return jwksCache.jwks;
}

function issuerCandidates(config: EntraConfig): string[] {
  const issuers = new Set<string>([
    `${config.authority}/v2.0`,
    config.authority,
  ]);
  if (config.tenantId) {
    issuers.add(`https://login.microsoftonline.com/${config.tenantId}/v2.0`);
    issuers.add(`https://sts.windows.net/${config.tenantId}/`);
  }
  return [...issuers];
}

function audienceCandidates(config: EntraConfig): string[] {
  const audiences = new Set<string>([config.audience, config.clientId].filter(Boolean));
  if (config.clientId) {
    audiences.add(`api://${config.clientId}`);
  }
  return [...audiences];
}

function claimString(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function usernameFromEntraClaims(input: {
  oid: string;
  preferredUsername?: string;
  email?: string;
}): string {
  const candidates = [input.preferredUsername, input.email].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const sanitized = candidate
      .replace(/@/g, ".")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 100);
    if (sanitized.length >= 3) return sanitized;
  }
  const compactOid = input.oid.replace(/-/g, "").slice(0, 20);
  return `entra_${compactOid}`;
}

export async function verifyEntraAccessToken(token: string): Promise<EntraIdentity> {
  const config = getEntraConfig();
  assertEntraConfigured(config);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getJwks(config.authority), {
      issuer: issuerCandidates(config),
      audience: audienceCandidates(config),
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Token validation failed";
    throw new EntraTokenError(detail);
  }

  const oid = claimString(payload, "oid") || claimString(payload, "sub");
  if (!oid) {
    throw new EntraTokenError("Entra token is missing the oid claim.");
  }

  const preferredUsername = claimString(payload, "preferred_username")
    || claimString(payload, "upn");
  const email = claimString(payload, "email") || preferredUsername;

  return {
    oid,
    preferredUsername,
    email,
    username: usernameFromEntraClaims({ oid, preferredUsername, email }),
  };
}
```

---

### 2. `backend/src/auth/password.ts`

```typescript
import crypto from "node:crypto";
const FORMAT = "scrypt";
const VERSION = "v1";
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;

export class PasswordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordValidationError";
  }
}

export function validatePasswordStrength(password: string): void {
  if (typeof password !== "string" || password.length < 12) {
    throw new PasswordValidationError("Password must be at least 12 characters long.");
  }
  if (password.length > 256) {
    throw new PasswordValidationError("Password must be no more than 256 characters long.");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new PasswordValidationError(
      "Password must contain uppercase, lowercase, and numeric characters.",
    );
  }
}

async function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePasswordStrength(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return [
    FORMAT,
    VERSION,
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 256 || typeof encoded !== "string") {
    return false;
  }
  const parts = encoded.split("$");
  if (parts.length !== 7 || parts[0] !== FORMAT || parts[1] !== VERSION) return false;

  const cost = Number(parts[2]);
  const blockSize = Number(parts[3]);
  const parallelization = Number(parts[4]);
  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[5], "base64");
    const expected = Buffer.from(parts[6], "base64");
    if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
    const actual = await derive(password, salt, cost, blockSize, parallelization);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

---

### 3. `backend/src/auth/session.ts`

```typescript
import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../db/connection";

export type UserRole = "admin" | "user";

export interface AuthenticatedUser {
  id: number;
  username: string;
  role: UserRole;
}

interface SessionUserRow extends RowDataPacket {
  id: number;
  username: string;
  role: UserRole;
}

function positiveIntegerEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export const SESSION_COOKIE_NAME = (() => {
  const value = (process.env.SESSION_COOKIE_NAME || "ai_session").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "ai_session";
})();

const SESSION_TTL_HOURS = positiveIntegerEnv("SESSION_TTL_HOURS", 8, 24 * 30);
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax" as const,
    maxAge: SESSION_TTL_MS,
    path: "/api",
  };
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at, last_seen_at)
     VALUES (?, ?, ?, NOW())`,
    [tokenHash(token), userId, expiresAt],
  );
  return { token, expiresAt };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(SESSION_COOKIE_NAME, options);
}

export async function resolveSession(req: Request): Promise<AuthenticatedUser | undefined> {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  if (!token || token.length > 128) return undefined;
  const hash = tokenHash(token);
  const [rows] = await pool.query<SessionUserRow[]>(
    `SELECT u.id, u.username, u.role
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.is_active = 1
      LIMIT 1`,
    [hash],
  );
  const user = rows[0];
  if (!user) return undefined;
  await pool.query(
    `UPDATE user_sessions
        SET last_seen_at = NOW()
      WHERE token_hash = ? AND last_seen_at < (NOW() - INTERVAL 5 MINUTE)`,
    [hash],
  );
  return { id: Number(user.id), username: user.username, role: user.role };
}

export async function revokeCurrentSession(req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  if (!token || token.length > 128) return;
  await pool.query(
    "UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE token_hash = ?",
    [tokenHash(token)],
  );
}

export async function revokeOtherSessions(req: Request, userId: number): Promise<number> {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  const currentHash = token && token.length <= 128 ? tokenHash(token) : "";
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE user_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL`,
    [userId, currentHash],
  );
  return result.affectedRows;
}

export async function revokeAllUserSessions(userId: number): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE user_sessions
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );
  return result.affectedRows;
}

export async function cleanupExpiredSessions(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE FROM user_sessions
      WHERE expires_at < (NOW() - INTERVAL 7 DAY)
         OR revoked_at < (NOW() - INTERVAL 7 DAY)`,
  );
  return result.affectedRows;
}
```

---

### 4. `backend/src/middleware/requireUserSession.ts`

```typescript
import type { NextFunction, Request, Response } from "express";
import { resolveSession } from "../auth/session";

export async function requireUserSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await resolveSession(req);
    if (!user) {
      res.status(401).json({
        error: "Authentication required",
        code: "USER_SESSION_REQUIRED",
        detail: "Log in from the sidebar profile menu and retry.",
      });
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
```

---

### 5. `backend/src/routes/auth.ts`

```typescript
import { Router, type NextFunction, type Request, type Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import pool from "../db/connection";
import {
  hashPassword,
  PasswordValidationError,
  validatePasswordStrength,
  verifyPassword,
} from "../auth/password";
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
  password_hash: string | null;
  role: UserRole;
  is_active: number;
  entra_oid: string | null;
}

const LoginSchema = z.object({
  username: z.string().trim().min(3).max(100),
  password: z.string().min(1).max(256),
}).strict();

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
}).strict();

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
    `SELECT id, username, password_hash, role, is_active, entra_oid
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
      `SELECT id, username, password_hash, role, is_active, entra_oid
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
      `INSERT INTO users (username, entra_oid, password_hash, role, is_active)
       VALUES (?, ?, NULL, ?, 1)`,
      [username, identity.oid, role],
    );
    await pool.query(
      "UPDATE users SET created_by = id, updated_by = id WHERE id = ?",
      [result.insertId],
    );
    const [created] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, password_hash, role, is_active, entra_oid
         FROM users WHERE id = ? LIMIT 1`,
      [result.insertId],
    );
    if (!created[0]) throw new Error("Failed to load the newly provisioned Entra user.");
    return created[0];
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [retry] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, password_hash, role, is_active, entra_oid
         FROM users WHERE entra_oid = ? LIMIT 1`,
      [identity.oid],
    );
    if (retry[0]) return retry[0];
    throw error;
  }
}

async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isEntraEnabled()) {
    res.status(403).json({
      error: "Password sign-in is disabled. Use Microsoft Entra ID.",
      code: "PASSWORD_LOGIN_DISABLED",
    });
    return;
  }

  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login request", code: "INVALID_LOGIN_REQUEST" });
    return;
  }
  try {
    const [rows] = await pool.query<LoginUserRow[]>(
      `SELECT id, username, password_hash, role, is_active, entra_oid
         FROM users WHERE username = ? LIMIT 1`,
      [parsed.data.username],
    );
    const user = rows[0];
    const valid = Boolean(user?.is_active)
      && Boolean(user?.password_hash)
      && await verifyPassword(parsed.data.password, user?.password_hash || "");
    if (!valid || !user) {
      res.status(401).json({
        error: "Invalid username or password",
        code: "INVALID_CREDENTIALS",
      });
      return;
    }

    await revokeCurrentSession(req);
    const session = await createSession(Number(user.id));
    setSessionCookie(res, session.token);
    res.json({ data: { user: safeUser(user), expiresAt: session.expiresAt.toISOString() } });
  } catch (error) {
    next(error);
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

async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isEntraEnabled()) {
    res.status(403).json({
      error: "Password changes are managed in Microsoft Entra ID.",
      code: "PASSWORD_CHANGE_DISABLED",
    });
    return;
  }

  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid password change request",
      code: "INVALID_PASSWORD_CHANGE",
      detail: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }
  try {
    validatePasswordStrength(parsed.data.newPassword);
    const [rows] = await pool.query<LoginUserRow[]>(
      "SELECT id, username, password_hash, role, is_active, entra_oid FROM users WHERE id = ? LIMIT 1",
      [req.user!.id],
    );
    const user = rows[0];
    if (!user?.password_hash || !await verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      res.status(401).json({ error: "Current password is incorrect", code: "INVALID_CREDENTIALS" });
      return;
    }
    const nextHash = await hashPassword(parsed.data.newPassword);
    await pool.query(
      "UPDATE users SET password_hash = ?, updated_by = ? WHERE id = ?",
      [nextHash, req.user!.id, req.user!.id],
    );
    const revokedSessions = await revokeOtherSessions(req, req.user!.id);
    res.json({ data: { changed: true, revokedSessions } });
  } catch (error) {
    if (error instanceof PasswordValidationError) {
      res.status(400).json({ error: error.message, code: "WEAK_PASSWORD" });
      return;
    }
    next(error);
  }
}

let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (routerInstance) return routerInstance;
  const router = Router();
  router.post("/login", rateLimiter({ maxPoints: 8, windowMs: 60_000 }), login);
  router.post("/entra/login", rateLimiter({ maxPoints: 8, windowMs: 60_000 }), entraLogin);
  router.post("/logout", requireUserSession, logout);
  router.get("/me", requireUserSession, me);
  router.post("/change-password", requireUserSession, changePassword);
  routerInstance = router;
  return router;
}
```

---

## Frontend Authentication & MSAL

### 6. `frontend/src/auth/msalConfig.js`

```javascript
import { PublicClientApplication, LogLevel } from "@azure/msal-browser";
function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}
const tenantId = trimEnv(import.meta.env.VITE_AZURE_ENTRA_TENANT_ID);
const clientId = trimEnv(import.meta.env.VITE_AZURE_ENTRA_CLIENT_ID);
const authorityFromEnv = trimEnv(import.meta.env.VITE_AZURE_ENTRA_AUTHORITY);
const apiScope = trimEnv(import.meta.env.VITE_AZURE_ENTRA_API_SCOPE);
const enabledFlag = trimEnv(import.meta.env.VITE_AZURE_ENTRA_ENABLED).toLowerCase();
const AUTH_QUERY_KEYS = [
  "code",
  "state",
  "session_state",
  "error",
  "error_description",
  "client_info",
  "iss",
];

function resolveRedirectUri() {
  const configured = trimEnv(import.meta.env.VITE_AZURE_ENTRA_REDIRECT_URI);
  if (!configured) {
    return window.location.origin;
  }
  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }
  try {
    return new URL(configured, window.location.origin).href.replace(/\/$/, "") === window.location.origin
      ? window.location.origin
      : new URL(configured, window.location.origin).href;
  } catch {
    return window.location.origin;
  }
}

const redirectUri = resolveRedirectUri();
const postLogoutRedirectUri = trimEnv(import.meta.env.VITE_AZURE_ENTRA_REDIRECT_URI) || window.location.origin;

const entraEnabled = enabledFlag === "" ? true : enabledFlag === "true";

const entraAuthority = authorityFromEnv
  || (tenantId ? `https://login.microsoftonline.com/${tenantId}` : "");

const entraLoginScopes = apiScope
  ? [apiScope, "openid", "profile", "email"]
  : ["openid", "profile", "email"];

export function getEntraConfigError() {
  if (!entraEnabled) {
    return "Microsoft Entra ID sign-in is disabled. Set VITE_AZURE_ENTRA_ENABLED=true.";
  }
  if (!clientId) {
    return "Missing VITE_AZURE_ENTRA_CLIENT_ID. Add it to frontend/.env.";
  }
  if (!entraAuthority) {
    return "Missing VITE_AZURE_ENTRA_AUTHORITY or VITE_AZURE_ENTRA_TENANT_ID. Add them to frontend/.env.";
  }
  return "";
}

export function isAuthPopupWindow() {
  try {
    if (typeof window === "undefined") return false;
    if (window.location.pathname.endsWith(DEFAULT_ENTRA_REDIRECT_PATH)) return true;
    return Boolean(window.opener && window.opener !== window);
  } catch {
    return false;
  }
}

export function clearMsalUrlResidue() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of AUTH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (url.hash && /(code|state|error|client_info)=/.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  if (changed) {
    const next = `${url.pathname}${url.search}${url.hash}` || "/";
    window.history.replaceState({}, document.title, next);
  }
}

const msalConfig = {
  auth: {
    clientId: clientId || "missing-client-id",
    authority: entraAuthority || "https://login.microsoftonline.com/common",
    redirectUri,
    postLogoutRedirectUri,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
    },
  },
};

const loginRequest = {
  scopes: entraLoginScopes,
};

let msalInstance;
let initializePromise;
let pendingRedirectResult = null;
let pendingRedirectConsumed = false;

export function getMsalInstance() {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
  }
  return msalInstance;
}

function pickEntraToken(result) {
  if (!apiScope && result?.idToken) return result.idToken;
  return result?.accessToken || result?.idToken || "";
}

export async function initializeMsal() {
  if (getEntraConfigError()) return getMsalInstance();
  if (!initializePromise) {
    initializePromise = (async () => {
      const instance = getMsalInstance();
      await instance.initialize();
      try {
        const result = await instance.handleRedirectPromise();
        clearMsalUrlResidue();
        if (result) {
          pendingRedirectResult = result;
          pendingRedirectConsumed = false;
          if (result.account) instance.setActiveAccount(result.account);
        } else {
          const accounts = instance.getAllAccounts();
          if (accounts.length > 0) instance.setActiveAccount(accounts[0]);
        }
      } catch (error) {
        clearMsalUrlResidue();
        console.error("MSAL handleRedirectPromise failed:", error);
      }
      return instance;
    })();
  }
  return initializePromise;
}

function consumeRedirectAuthResult() {
  if (pendingRedirectConsumed) return null;
  pendingRedirectConsumed = true;
  const result = pendingRedirectResult;
  pendingRedirectResult = null;
  return result;
}

export async function beginEntraLoginRedirect() {
  const configError = getEntraConfigError();
  if (configError) throw new Error(configError);
  if (isAuthPopupWindow()) {
    throw new Error("Sign-in must start from the main application window.");
  }
  const instance = await initializeMsal();
  clearMsalUrlResidue();
  await instance.loginRedirect({
    ...loginRequest,
    prompt: "select_account",
  });
}

let redirectSessionPromise = null;

export async function establishSessionFromRedirect(loginWithEntra) {
  if (!redirectSessionPromise) {
    redirectSessionPromise = (async () => {
      await initializeMsal();
      const result = consumeRedirectAuthResult();
      if (!result) return null;
      const token = pickEntraToken(result);
      if (!token) {
        throw new Error("Microsoft sign-in returned no token.");
      }
      return loginWithEntra(token);
    })();
  }
  return redirectSessionPromise;
}

export async function clearEntraSession() {
  clearMsalUrlResidue();
  if (getEntraConfigError()) return;
  const instance = await initializeMsal();
  const account = instance.getActiveAccount() || instance.getAllAccounts()[0];
  try {
    if (account) {
      await instance.clearCache({ account });
    } else {
      await instance.clearCache();
    }
  } catch {
    // ignore cache clear failures; app cookie is already revoked
  }
  instance.setActiveAccount(null);
  clearMsalUrlResidue();
}
```

---

### 7. `frontend/src/auth/AuthContext.jsx`

```javascript
/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getCurrentUser,
  loginWithEntra,
  logoutUser,
} from "../api/services";
import {
  beginEntraLoginRedirect,
  clearEntraSession,
  clearMsalUrlResidue,
  establishSessionFromRedirect,
  getEntraConfigError,
  initializeMsal,
  isAuthPopupWindow,
} from "./msalConfig";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => !isAuthPopupWindow());
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (isAuthPopupWindow()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const current = await getCurrentUser();
      setUser(current);
      setError("");
      return current;
    } catch (requestError) {
      if (requestError?.response?.status === 401) {
        setUser(null);
        setError("");
        return null;
      }
      setError(requestError?.response?.data?.error || requestError?.message || "Unable to check login state.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthPopupWindow()) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        await initializeMsal();
        clearMsalUrlResidue();
        const redirectUser = await establishSessionFromRedirect(loginWithEntra);
        if (cancelled) return;
        if (redirectUser) {
          setUser(redirectUser);
          setError("");
          setLoading(false);
          return;
        }
        await refresh();
      } catch (err) {
        console.error("Failed to complete Microsoft redirect sign-in:", err);
        if (!cancelled) {
          setError(err?.response?.data?.error || err?.message || "Unable to complete Microsoft sign-in.");
          setLoading(false);
          await refresh().catch(() => undefined);
        }
      }
    })();

    const handleExpired = () => {
      setUser(null);
      setLoading(false);
      if (typeof window !== "undefined" && (window.location.pathname !== "/" || window.location.search || window.location.hash)) {
        window.location.replace("/");
      }
    };
    window.addEventListener("auth:session-expired", handleExpired);
    return () => {
      cancelled = true;
      window.removeEventListener("auth:session-expired", handleExpired);
    };
  }, [refresh]);

  const loginWithMicrosoft = useCallback(async () => {
    setError("");
    const configError = getEntraConfigError();
    if (configError) {
      setError(configError);
      throw new Error(configError);
    }
    await beginEntraLoginRedirect();
  }, []);

  const logout = useCallback(async () => {
    setError("");
    try {
      await logoutUser();
    } catch {
      // Still clear local UI / Entra even if the cookie revoke call fails.
    } finally {
      setUser(null);
      clearMsalUrlResidue();
      try {
        await clearEntraSession();
      } catch {
        clearMsalUrlResidue();
      }
      if (typeof window !== "undefined" && (window.location.pathname !== "/" || window.location.search || window.location.hash)) {
        window.location.replace("/");
      }
    }
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    error,
    isAdmin: user?.role === "admin",
    loginWithMicrosoft,
    logout,
    refresh,
  }), [user, loading, error, loginWithMicrosoft, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
```

---

### 8. `frontend/src/auth/LoginGate.jsx`

```javascript
import { useState } from "react";
import { useAuth } from "./AuthContext";
import { getEntraConfigError } from "./msalConfig";

export default function LoginGate({ children }) {
  const { user, loading, error: sessionError, loginWithMicrosoft } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const configError = getEntraConfigError();

  if (loading) {
    return (
      <div className="bg-dashboard flex min-h-dvh items-center justify-center px-4">
        <div className="rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-8 shadow-[var(--theme-card-shadow)]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--theme-border) border-b-(--theme-primary)" aria-label="Checking login session" />
        </div>
      </div>
    );
  }

  if (user) return children;

  const submit = async () => {
    setSubmitting(true);
    setMessage("");
    try {
      await loginWithMicrosoft();
    } catch (requestError) {
      setMessage(
        requestError?.response?.data?.detail
        || requestError?.response?.data?.error
        || requestError?.message
        || "Unable to sign in with Microsoft.",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="bg-dashboard flex min-h-dvh items-center justify-center px-4 py-6 sm:py-8">
      <section className="w-full max-w-sm rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-5 shadow-[var(--theme-card-shadow)] sm:p-6">
        <img src="/srm-title-logo.png" alt="SRMTech" className="mx-auto h-auto w-24" />
        <div className="mt-4 text-center">
          <h1 className="text-xl! leading-tight! font-bold text-(--theme-text)">Welcome Back</h1>
          <p className="mt-1.5 text-sm font-medium text-(--theme-text-muted)">
            Please sign in with your Microsoft account to continue.
          </p>
        </div>

        <div className="mt-5 space-y-3">
          {(message || sessionError || configError) && (
            <p role="alert" className="rounded-[var(--theme-radius-btn)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {message || sessionError || configError}
            </p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={submitting || Boolean(configError)}
            className="btn-primary flex w-full items-center justify-center gap-2 py-2.5!"
          >
            <MicrosoftMark />
            {submitting ? "Signing in..." : "Sign in with Microsoft"}
          </button>
        </div>
      </section>
    </main>
  );
}

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
```
