import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "../auth/session";

export function requireRole(...roles: UserRole[]) {
  const allowed = new Set(roles);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required", code: "USER_SESSION_REQUIRED" });
      return;
    }
    if (!allowed.has(req.user.role)) {
      res.status(403).json({
        error: "Forbidden",
        code: "INSUFFICIENT_ROLE",
        detail: `This action requires one of these roles: ${roles.join(", ")}.`,
      });
      return;
    }
    next();
  };
}

