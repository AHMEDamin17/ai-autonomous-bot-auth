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

