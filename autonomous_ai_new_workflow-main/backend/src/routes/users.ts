import { Router, type NextFunction, type Request, type Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import pool from "../db/connection";
import { revokeAllUserSessions, type UserRole } from "../auth/session";

interface SafeUserRow extends RowDataPacket {
  id: number;
  username: string;
  role: UserRole;
  is_active: number;
  created_at: Date;
  updated_at: Date;
  created_by_username: string | null;
  updated_by_username: string | null;
}

const UsernameSchema = z.string().trim().regex(
  /^[A-Za-z0-9._-]{3,100}$/,
  "Username must be 3-100 letters, numbers, dots, underscores, or hyphens.",
);

const CreateUserSchema = z.object({
  username: UsernameSchema,
  role: z.enum(["admin", "user"]).default("user"),
}).strict();

const UpdateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => value.role !== undefined || value.isActive !== undefined, {
  message: "At least one user field must be changed.",
});

function parseUserId(value: string): number | undefined {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function isDuplicateEntry(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

async function listUsers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [rows] = await pool.query<SafeUserRow[]>(
      `SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.updated_at,
              creator.username AS created_by_username,
              updater.username AS updated_by_username
         FROM users u
         LEFT JOIN users creator ON creator.id = u.created_by
         LEFT JOIN users updater ON updater.id = u.updated_by
        ORDER BY u.username`,
    );
    res.json({
      data: rows.map((row) => ({
        id: Number(row.id),
        username: row.username,
        role: row.role,
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by_username,
        updatedBy: row.updated_by_username,
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function createUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid user",
      code: "INVALID_USER",
      detail: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }
  try {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (username, role, is_active, created_by, updated_by)
       VALUES (?, ?, 1, ?, ?)`,
      [parsed.data.username, parsed.data.role, req.user!.id, req.user!.id],
    );
    res.status(201).json({
      data: {
        id: result.insertId,
        username: parsed.data.username,
        role: parsed.data.role,
        isActive: true,
      },
    });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      res.status(409).json({ error: "Username already exists", code: "USERNAME_EXISTS" });
      return;
    }
    next(error);
  }
}

async function updateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = parseUserId(req.params.id);
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(400).json({ error: "Invalid user update", code: "INVALID_USER_UPDATE" });
    return;
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, username, role, is_active FROM users WHERE id = ? LIMIT 1",
      [id],
    );
    const target = rows[0];
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const nextRole = parsed.data.role ?? target.role;
    const nextActive = parsed.data.isActive ?? Boolean(target.is_active);
    const removesAdmin = target.role === "admin" && Boolean(target.is_active)
      && (nextRole !== "admin" || !nextActive);
    if (removesAdmin) {
      const [adminCounts] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1",
      );
      if (Number(adminCounts[0]?.total ?? 0) <= 1) {
        res.status(409).json({
          error: "The final active administrator cannot be deactivated or demoted.",
          code: "FINAL_ADMIN_REQUIRED",
        });
        return;
      }
    }

    await pool.query(
      "UPDATE users SET role = ?, is_active = ?, updated_by = ? WHERE id = ?",
      [nextRole, nextActive ? 1 : 0, req.user!.id, id],
    );
    if (!nextActive || nextRole !== target.role) {
      await revokeAllUserSessions(id);
    }
    res.json({
      data: { id, username: target.username, role: nextRole, isActive: nextActive },
    });
  } catch (error) {
    next(error);
  }
}

let routerInstance: Router | null = null;

export function getRouter(): Router {
  if (routerInstance) return routerInstance;
  const router = Router();
  router.get("/", listUsers);
  router.post("/", createUser);
  router.patch("/:id", updateUser);
  routerInstance = router;
  return router;
}
