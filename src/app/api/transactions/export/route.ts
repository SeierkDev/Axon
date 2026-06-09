// GET /api/transactions/export?format=csv
// Exports all transactions for the authenticated wallet as CSV.
// Requires Authorization: Bearer <apiKey>.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { getDb } from "@/lib/db";
import { apiError } from "@/lib/apiError";

function escCsv(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  if (format !== "csv") {
    return apiError("VALIDATION_ERROR", "Only format=csv is supported", 400);
  }

  interface TxRow {
    tx_id: string;
    task_id: string | null;
    from_agent: string;
    to_agent: string;
    amount_sol: number;
    currency: string;
    status: string;
    signature: string | null;
    created_at: string;
    settled_at: string | null;
  }

  // Return only transactions involving this wallet's agents
  const rows = getDb().prepare(`
    SELECT tx_id, task_id, from_agent, to_agent, amount_sol, currency, status, signature, created_at, settled_at
    FROM transactions
    WHERE from_agent IN (SELECT agent_id FROM agents WHERE wallet_address = ?)
       OR to_agent   IN (SELECT agent_id FROM agents WHERE wallet_address = ?)
    ORDER BY created_at DESC
    LIMIT 10000
  `).all(auth.user.walletAddress, auth.user.walletAddress) as TxRow[];

  const header = ["tx_id", "task_id", "from_agent", "to_agent", "amount", "currency", "status", "signature", "created_at", "settled_at"].join(",");
  const lines = rows.map((r) => [
    escCsv(r.tx_id),
    escCsv(r.task_id),
    escCsv(r.from_agent),
    escCsv(r.to_agent),
    escCsv(r.amount_sol),
    escCsv(r.currency),
    escCsv(r.status),
    escCsv(r.signature),
    escCsv(r.created_at),
    escCsv(r.settled_at),
  ].join(","));

  const csv = [header, ...lines].join("\r\n");
  const filename = `axon-transactions-${auth.user.walletAddress.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
