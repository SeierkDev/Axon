import { NextRequest } from "next/server";

// Moderator-only actions are gated by MODERATION_SECRET (open in local dev).
export function isModerator(req: NextRequest): boolean {
  const secret = process.env.MODERATION_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
