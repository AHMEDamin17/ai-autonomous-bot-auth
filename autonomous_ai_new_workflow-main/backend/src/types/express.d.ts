import type { AuthenticatedUser } from "../auth/session";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};

