import "dotenv/config";
import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResultSetHeader } from "mysql2";
import app from "../src/server";
import pool from "../src/db/connection";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session";

interface TestIdentity {
  id: number;
  username: string;
  role: "admin" | "user";
}

async function createIdentity(role: "admin" | "user"): Promise<TestIdentity> {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const username = `auth_test_${role}_${suffix}`;
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO users (username, role, is_active)
     VALUES (?, ?, 1)`,
    [username, role],
  );
  await pool.query("UPDATE users SET created_by = id, updated_by = id WHERE id = ?", [result.insertId]);
  return { id: result.insertId, username, role };
}

async function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-api-key", process.env.API_KEY || "default-dev-key");
  if (init.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function login(_baseUrl: string, identity: TestIdentity): Promise<string> {
  const session = await createSession(identity.id);
  return `${SESSION_COOKIE_NAME}=${session.token}`;
}

function expectStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}.`);
  }
}

async function main(): Promise<void> {
  const identities: TestIdentity[] = [];
  let server: Server | undefined;
  try {
    identities.push(await createIdentity("admin"), await createIdentity("user"));
    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const adminCookie = await login(baseUrl, identities[0]);
    const userCookie = await login(baseUrl, identities[1]);

    expectStatus(await request(baseUrl, "/api/auth/me", {}, adminCookie), 200, "Admin /me");
    expectStatus(await request(baseUrl, "/api/users", {}, adminCookie), 200, "Admin user list");
    expectStatus(await request(baseUrl, "/api/users", {}, userCookie), 403, "User admin route");
    expectStatus(await request(baseUrl, "/api/connections", {}, userCookie), 200, "User read route");
    expectStatus(await request(baseUrl, "/api/connections", {
      method: "POST",
      headers: { "X-User-Id": String(identities[0].id) },
      body: JSON.stringify({}),
    }, userCookie), 403, "Forged user header");
    await pool.query(
      "UPDATE user_sessions SET expires_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 MINUTE) WHERE user_id = ?",
      [identities[1].id],
    );
    expectStatus(await request(baseUrl, "/api/auth/me", {}, userCookie), 401, "Expired session");
    expectStatus(await request(baseUrl, "/api/auth/logout", { method: "POST" }, adminCookie), 200, "Logout");
    expectStatus(await request(baseUrl, "/api/auth/me", {}, adminCookie), 401, "Revoked session");
    console.log("Auth self-test passed: session expiry/revocation, logout, role, read access, and header-forgery guards.");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const identity of identities) {
      await pool.query("UPDATE users SET created_by = NULL, updated_by = NULL WHERE id = ?", [identity.id]).catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id = ?", [identity.id]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`[auth-selftest] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
