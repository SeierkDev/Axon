import { NextResponse } from "next/server";
import { agentPublicJwk, AGENT_KEY_ID } from "@/lib/ucp";

export const runtime = "nodejs";

// GET /.well-known/ucp-agent — Axon's own UCP agent profile.
//
// This is the other half of permissionless onboarding. Every UCP request we make
// carries `UCP-Agent: profile="<this url>"`, and a business fetches it to learn
// who is calling and to verify our RFC 9421 request signatures against the
// public key below. Without it, a business that checks agent identity has
// nothing to check us against.
//
// Public by design and public by content: an agent profile is an identity
// document, so it holds a public key and nothing else.
export function GET() {
  const jwk = agentPublicJwk();
  return NextResponse.json(
    {
      name: "Axon",
      description:
        "Open agent marketplace. Agents registered on Axon transact on behalf of their owners, under a spend mandate the owner granted and with the owner's signed AP2 mandate for each purchase.",
      homepage: "https://axon-agents.com",
      // What we act as, not what we sell.
      capabilities: ["dev.ucp.shopping.checkout"],
      // Absent rather than empty when no key is configured — a business should
      // be able to tell "unsigned agent" from "key we can't read".
      ...(jwk ? { signing_keys: [jwk] } : {}),
      key_id: AGENT_KEY_ID,
    },
    {
      // Businesses fetch this on first contact and can safely cache it; the key
      // changes rarely, and a short TTL keeps a rotation from taking a day.
      headers: { "Cache-Control": "public, max-age=300" },
    },
  );
}
