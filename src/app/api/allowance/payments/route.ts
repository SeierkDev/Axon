// GET /api/allowance/payments: every payment made from this wallet's allowance, newest first.
//
// A full key sees them all, with which key paid each. An allowance key sees only its own, the same
// line it holds everywhere: a leaked assistant key shows that assistant's spending, not the owner's.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { getDb } from "@/lib/db";
import { weiToDecimalString } from "@/lib/money";
import { NATIVE_TOKEN } from "@/lib/allowancePolicy";

interface Row {
  task_id: string;
  token: string;
  amount_units: string;
  state: string;
  reserve_tx: string;
  close_tx: string | null;
  created_at: string;
  closed_at: string | null;
  task_key: string;
  api_key_id: string | null;
  key_label: string | null;
  to_agent: string | null;
}

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 50, 1), 200);

  const ownKeyOnly = auth.user.scope === "allowance";
  const rows = getDb().prepare(`
    SELECT r.task_id, r.token, r.amount_units, r.state, r.reserve_tx, r.close_tx, r.created_at, r.closed_at,
           r.task_key, r.api_key_id, k.label AS key_label, t.to_agent
    FROM allowance_reservations r
    LEFT JOIN api_keys k ON k.key_id = r.api_key_id
    LEFT JOIN tasks t ON t.task_id = r.task_id
    WHERE r.owner = ? ${ownKeyOnly ? "AND r.api_key_id = ?" : ""}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(...(ownKeyOnly ? [auth.user.walletAddress, auth.user.keyId, limit] : [auth.user.walletAddress, limit])) as Row[];

  return NextResponse.json({
    payments: rows.map((r) => ({
      taskId: r.task_id,
      agentId: r.to_agent,
      token: r.token === NATIVE_TOKEN ? "ETH" : "AXON",
      amount: weiToDecimalString(BigInt(r.amount_units)),
      state: r.state,
      taskKey: r.task_key,
      reserveTx: r.reserve_tx,
      closeTx: r.close_tx,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      paidWithKey: r.api_key_id ? { keyId: r.api_key_id, label: r.key_label } : null,
      receiptUrl: `/r/${r.task_id}`,
    })),
  });
}
