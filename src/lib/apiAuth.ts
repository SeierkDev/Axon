import { type NextRequest, type NextResponse } from "next/server";
import { apiError } from "./apiError";
import { authenticateApiKey, isAgentOwner, type AuthenticatedUser } from "./identity";

export type AuthResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: NextResponse };

export type AgentOwnerResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; response: NextResponse };

export function requireApiKey(req: NextRequest): AuthResult {
  const user = authenticateApiKey(req);
  if (!user) {
    return {
      ok: false,
      response: apiError(
        "AUTH_REQUIRED",
        "Missing or invalid API key. Use Authorization: Bearer <apiKey> or X-API-Key.",
        401
      ),
    };
  }

  return { ok: true, user };
}

export function requireAgentOwner(req: NextRequest, agentId: string): AgentOwnerResult {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth;

  if (!isAgentOwner(auth.user, agentId)) {
    return {
      ok: false,
      response: apiError(
        "FORBIDDEN",
        "API key does not belong to this agent's wallet owner",
        403
      ),
    };
  }

  return auth;
}

export function canAccessIdentity(user: AuthenticatedUser, identity: string): boolean {
  return identity === user.walletAddress || isAgentOwner(user, identity);
}
