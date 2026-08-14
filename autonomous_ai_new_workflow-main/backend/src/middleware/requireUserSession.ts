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

