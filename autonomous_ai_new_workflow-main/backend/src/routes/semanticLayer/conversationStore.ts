import crypto from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../../db/connection";

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  queryResult?: any;
  tableHint?: string;
  columnHints?: string[];
  timestamp: number;
}

export interface Conversation {
  id: string;
  connectionId: string;
  userId?: string;
  messages: ConversationMessage[];
  createdAt: number;
  lastActivityAt: number;
}

export interface ConversationContext {
  conversationId: string;
  referencedTables: string[];
  referencedColumns: string[];
  lastTopic: string | null;
  messageCount: number;
}

export class ConversationConnectionNotFoundError extends Error {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`);
    this.name = "ConversationConnectionNotFoundError";
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_CONVERSATIONS = positiveIntegerEnv("MAX_CONVERSATIONS", 10);
const MAX_MESSAGES_PER_CONVERSATION = 20;
const CONVERSATION_TTL_MINUTES = 30;

function safeJsonParse(value: unknown): any {
  if (value == null) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function toMessage(row: RowDataPacket): ConversationMessage {
  return {
    role: row.role,
    content: row.content,
    queryResult: safeJsonParse(row.query_result) ?? undefined,
    tableHint: row.table_hint || undefined,
    columnHints: safeJsonParse(row.column_hints) || undefined,
    timestamp: new Date(row.created_at).getTime(),
  };
}

// Create
export async function createConversation(
  connectionId: string | number,
  userId: string | number,
): Promise<Conversation> {
  const connId = Number(connectionId);
  const ownerId = Number(userId);
  if (!Number.isInteger(connId) || connId <= 0) {
    throw new Error(`Invalid connectionId: ${connectionId}`);
  }
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("A valid authenticated user is required.");
  }

  const [connectionRows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM db_connections WHERE id = ? LIMIT 1",
    [connId],
  );
  if (!connectionRows.length) {
    throw new ConversationConnectionNotFoundError(connId);
  }

  // Evict oldest conversations if at capacity (mirrors the old in-memory eviction).
  const [countRows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM conversations WHERE user_id = ?",
    [ownerId],
  );
  const total = Number(countRows[0]?.total || 0);
  if (total >= MAX_CONVERSATIONS) {
    await pool.query(
      `DELETE FROM conversations WHERE id IN (
         SELECT id FROM (
           SELECT id FROM conversations WHERE user_id = ? ORDER BY last_activity_at ASC LIMIT ?
         ) AS oldest
       )`,
      [ownerId, total - MAX_CONVERSATIONS + 1],
    );
  }

  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO conversations (id, connection_id, user_id) VALUES (?, ?, ?)",
    [id, connId, ownerId],
  );

  const now = Date.now();
  return {
    id,
    connectionId: String(connId),
    userId: String(ownerId),
    messages: [],
    createdAt: now,
    lastActivityAt: now,
  };
}

// Read (also touches last_activity_at; returns undefined if missing, expired,
// or owned by a different connection).
export async function getConversation(
  id: string,
  userId: string | number,
  expectedConnectionId?: string | number,
): Promise<Conversation | undefined> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return undefined;
  const connId = expectedConnectionId === undefined ? undefined : Number(expectedConnectionId);
  if (connId !== undefined && (!Number.isInteger(connId) || connId <= 0)) {
    return undefined;
  }

  const ownershipSql = connId === undefined ? "" : " AND connection_id = ?";
  const queryParams = connId === undefined
    ? [id, CONVERSATION_TTL_MINUTES, ownerId]
    : [id, CONVERSATION_TTL_MINUTES, ownerId, connId];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM conversations
     WHERE id = ? AND last_activity_at > (NOW() - INTERVAL ? MINUTE)
       AND user_id = ?${ownershipSql}`,
    queryParams,
  );
  if (!rows.length) return undefined;

  const updateParams = connId === undefined ? [id, ownerId] : [id, ownerId, connId];
  await pool.query(
    `UPDATE conversations SET last_activity_at = NOW()
      WHERE id = ? AND user_id = ?${connId === undefined ? "" : " AND connection_id = ?"}`,
    updateParams,
  );

  const row = rows[0]!;
  const [msgRows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ?",
    [id, MAX_MESSAGES_PER_CONVERSATION],
  );

  return {
    id: row.id,
    connectionId: String(row.connection_id),
    userId: String(row.user_id),
    messages: msgRows.map(toMessage),
    createdAt: new Date(row.created_at).getTime(),
    lastActivityAt: Date.now(),
  };
}

// Append
export async function addMessage(
  convId: string,
  userId: string | number,
  msg: ConversationMessage,
): Promise<void> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("A valid authenticated user is required.");
  }
  // Strip large data payloads before storage to prevent unbounded growth.
  // Copy rather than mutate msg.queryResult in place -- callers (e.g. the
  // analytics query route) still serialize that same object as the API
  // response after calling addMessage, and must keep their own rows intact.
  let queryResult = msg.queryResult;
  if (queryResult && queryResult.data && Array.isArray(queryResult.data.rows)) {
    queryResult = { ...queryResult, data: { ...queryResult.data, rows: [] } };
  }

  const [insertResult] = await pool.query<ResultSetHeader>(
    `INSERT INTO conversation_messages (conversation_id, role, content, query_result, table_hint, column_hints)
     SELECT c.id, ?, ?, ?, ?, ?
       FROM conversations c
      WHERE c.id = ? AND c.user_id = ?`,
    [
      msg.role,
      msg.content,
      queryResult != null ? JSON.stringify(queryResult) : null,
      msg.tableHint || null,
      msg.columnHints ? JSON.stringify(msg.columnHints) : null,
      convId,
      ownerId,
    ],
  );
  if (!insertResult.affectedRows) throw new Error("Conversation is unavailable for this user.");

  await pool.query(
    "UPDATE conversations SET last_activity_at = NOW() WHERE id = ? AND user_id = ?",
    [convId, ownerId],
  );

  // Cap at MAX_MESSAGES_PER_CONVERSATION, keeping the most recent.
  await pool.query(
    `DELETE FROM conversation_messages WHERE conversation_id = ? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) AS keep
     )`,
    [convId, convId, MAX_MESSAGES_PER_CONVERSATION],
  );
}

// Delete one conversation only when it belongs to the selected connection.
// The FK on conversation_messages handles message deletion atomically.
export async function deleteConversation(
  id: string,
  expectedConnectionId: string | number,
  userId: string | number,
): Promise<boolean> {
  const connId = Number(expectedConnectionId);
  const ownerId = Number(userId);
  if (!Number.isInteger(connId) || connId <= 0 || !Number.isInteger(ownerId) || ownerId <= 0) return false;

  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM conversations WHERE id = ? AND connection_id = ? AND user_id = ?",
    [id, connId, ownerId],
  );
  return result.affectedRows > 0;
}

// Clear every persisted conversation for one connection. This is intentionally
// connection-scoped; conversations belonging to other connections are untouched.
export async function deleteConversationsByConnection(
  connectionId: string | number,
  userId: string | number,
): Promise<number> {
  const connId = Number(connectionId);
  const ownerId = Number(userId);
  if (!Number.isInteger(connId) || connId <= 0 || !Number.isInteger(ownerId) || ownerId <= 0) return 0;

  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM conversations WHERE connection_id = ? AND user_id = ?",
    [connId, ownerId],
  );
  return result.affectedRows;
}

export function buildConversationContextFromConversation(conv: Conversation): ConversationContext {
  // Scan the last 6 messages (3 exchanges) to find referenced tables/columns.
  const newestFirst = [...conv.messages].reverse();
  const recentMessages = newestFirst.slice(0, 6);
  const referencedTables = new Set<string>();
  const referencedColumns = new Set<string>();
  for (const message of recentMessages) {
    if (message.tableHint) referencedTables.add(message.tableHint);
    if (Array.isArray(message.columnHints)) {
      message.columnHints.forEach((column) => referencedColumns.add(column));
    }
  }

  const lastAssistantMessage = newestFirst.find((message) => message.role === "assistant");

  return {
    conversationId: conv.id,
    referencedTables: [...referencedTables],
    referencedColumns: [...referencedColumns],
    lastTopic: lastAssistantMessage?.content || null,
    messageCount: conv.messages.length,
  };
}

// Build context for classifier/LLM while enforcing connection ownership.
export async function buildConversationContext(
  convId: string,
  userId: string | number,
  expectedConnectionId?: string | number,
): Promise<ConversationContext> {
  const conv = await getConversation(convId, userId, expectedConnectionId);
  if (!conv) {
    return { conversationId: convId, referencedTables: [], referencedColumns: [], lastTopic: null, messageCount: 0 };
  }
  return buildConversationContextFromConversation(conv);
}

// Cleanup (called periodically below; safe to call manually too)
export async function cleanupExpired(): Promise<number> {
  const [result] = await pool.query<any>(
    "DELETE FROM conversations WHERE last_activity_at < (NOW() - INTERVAL ? MINUTE)",
    [CONVERSATION_TTL_MINUTES],
  );
  return result.affectedRows || 0;
}

const cleanupTimer = setInterval(() => {
  cleanupExpired().catch((err) => console.error("[ConversationStore] cleanup failed:", err.message));
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
