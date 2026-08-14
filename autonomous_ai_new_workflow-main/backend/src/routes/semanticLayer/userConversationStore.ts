import crypto from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import pool from "../../db/connection";
import type { ConversationContext, ConversationMessage } from "./conversationStore";

export interface UserConversation {
  id: string;
  connectionId: string | null;
  userId?: string;
  messages: ConversationMessage[];
  createdAt: number;
  lastActivityAt: number;
}

export class UserConversationConnectionNotFoundError extends Error {
  constructor(connectionId: number) {
    super(`Connection ${connectionId} not found`);
    this.name = "UserConversationConnectionNotFoundError";
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const MAX_CONVERSATIONS = positiveIntegerEnv(
  "MAX_USER_CONVERSATIONS",
  positiveIntegerEnv("MAX_CONVERSATIONS", 10),
);
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

async function assertConnectionExists(connectionId: number): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM db_connections WHERE id = ? LIMIT 1",
    [connectionId],
  );
  if (!rows.length) {
    throw new UserConversationConnectionNotFoundError(connectionId);
  }
}

async function evictAtCapacity(userId: number): Promise<void> {
  const [countRows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM user_conversations WHERE user_id = ?",
    [userId],
  );
  const total = Number(countRows[0]?.total || 0);
  if (total < MAX_CONVERSATIONS) return;

  await pool.query(
    `DELETE FROM user_conversations WHERE id IN (
       SELECT id FROM (
         SELECT id FROM user_conversations WHERE user_id = ? ORDER BY last_activity_at ASC LIMIT ?
       ) AS oldest
     )`,
    [userId, total - MAX_CONVERSATIONS + 1],
  );
}

export async function createUserConversation(
  connectionId?: string | number | null,
  userId?: string | number,
): Promise<UserConversation> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("A valid authenticated user is required.");
  }
  const connId = connectionId == null ? null : Number(connectionId);
  if (connId !== null && (!Number.isInteger(connId) || connId <= 0)) {
    throw new Error(`Invalid connectionId: ${connectionId}`);
  }
  if (connId !== null) {
    await assertConnectionExists(connId);
  }

  await evictAtCapacity(ownerId);
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO user_conversations (id, connection_id, user_id) VALUES (?, ?, ?)",
    [id, connId, ownerId],
  );

  const now = Date.now();
  return {
    id,
    connectionId: connId === null ? null : String(connId),
    userId: String(ownerId),
    messages: [],
    createdAt: now,
    lastActivityAt: now,
  };
}

export async function getUserConversation(
  id: string,
  userId: string | number,
): Promise<UserConversation | undefined> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return undefined;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM user_conversations
      WHERE id = ?
        AND user_id = ?
        AND last_activity_at > (NOW() - INTERVAL ? MINUTE)`,
    [id, ownerId, CONVERSATION_TTL_MINUTES],
  );
  if (!rows.length) return undefined;

  await pool.query(
    "UPDATE user_conversations SET last_activity_at = NOW() WHERE id = ? AND user_id = ?",
    [id, ownerId],
  );
  const [messageRows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM user_conversation_messages
      WHERE conversation_id = ?
      ORDER BY id ASC
      LIMIT ?`,
    [id, MAX_MESSAGES_PER_CONVERSATION],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    userId: String(row.user_id),
    messages: messageRows.map(toMessage),
    createdAt: new Date(row.created_at).getTime(),
    lastActivityAt: Date.now(),
  };
}

export async function pinUserConversation(
  id: string,
  connectionId: string | number,
  userId: string | number,
): Promise<boolean> {
  const connId = Number(connectionId);
  const ownerId = Number(userId);
  if (!Number.isInteger(connId) || connId <= 0 || !Number.isInteger(ownerId) || ownerId <= 0) return false;
  await assertConnectionExists(connId);

  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE user_conversations
        SET connection_id = ?, last_activity_at = NOW()
      WHERE id = ?
        AND user_id = ?
        AND (connection_id IS NULL OR connection_id = ?)`,
    [connId, id, ownerId, connId],
  );
  return result.affectedRows > 0;
}

export async function addUserMessage(
  conversationId: string,
  userId: string | number,
  message: ConversationMessage,
): Promise<void> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error("A valid authenticated user is required.");
  }
  let queryResult = message.queryResult;
  if (queryResult?.data && Array.isArray(queryResult.data.rows)) {
    queryResult = {
      ...queryResult,
      data: { ...queryResult.data, rows: [] },
    };
  }

  const [insertResult] = await pool.query<ResultSetHeader>(
    `INSERT INTO user_conversation_messages
       (conversation_id, role, content, query_result, table_hint, column_hints)
     SELECT c.id, ?, ?, ?, ?, ?
       FROM user_conversations c
      WHERE c.id = ? AND c.user_id = ?`,
    [
      message.role,
      message.content,
      queryResult != null ? JSON.stringify(queryResult) : null,
      message.tableHint || null,
      message.columnHints ? JSON.stringify(message.columnHints) : null,
      conversationId,
      ownerId,
    ],
  );
  if (!insertResult.affectedRows) throw new Error("Conversation is unavailable for this user.");
  await pool.query(
    "UPDATE user_conversations SET last_activity_at = NOW() WHERE id = ? AND user_id = ?",
    [conversationId, ownerId],
  );
  await pool.query(
    `DELETE FROM user_conversation_messages
      WHERE conversation_id = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM user_conversation_messages
             WHERE conversation_id = ?
             ORDER BY id DESC
             LIMIT ?
          ) AS keep
        )`,
    [conversationId, conversationId, MAX_MESSAGES_PER_CONVERSATION],
  );
}

export async function deleteUserConversation(
  id: string,
  userId: string | number,
): Promise<boolean> {
  const ownerId = Number(userId);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return false;
  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM user_conversations WHERE id = ? AND user_id = ?",
    [id, ownerId],
  );
  return result.affectedRows > 0;
}

export function buildUserConversationContext(
  conversation: UserConversation,
): ConversationContext {
  const recentMessages = [...conversation.messages].reverse().slice(0, 6);
  const referencedTables = new Set<string>();
  const referencedColumns = new Set<string>();
  for (const message of recentMessages) {
    if (message.tableHint) referencedTables.add(message.tableHint);
    message.columnHints?.forEach((column) => referencedColumns.add(column));
  }
  const lastAssistantMessage = recentMessages.find(
    (message) => message.role === "assistant",
  );
  return {
    conversationId: conversation.id,
    referencedTables: [...referencedTables],
    referencedColumns: [...referencedColumns],
    lastTopic: lastAssistantMessage?.content || null,
    messageCount: conversation.messages.length,
  };
}

export async function cleanupExpiredUserConversations(): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE FROM user_conversations
      WHERE last_activity_at < (NOW() - INTERVAL ? MINUTE)`,
    [CONVERSATION_TTL_MINUTES],
  );
  return result.affectedRows || 0;
}

const cleanupTimer = setInterval(() => {
  cleanupExpiredUserConversations().catch((error) => {
    console.error("[UserConversationStore] cleanup failed:", error.message);
  });
}, 5 * 60 * 1000);
cleanupTimer.unref?.();
