// The "commerce" grant, as tools an agent can actually call.
//
// Two tools, deliberately: find things, and propose buying them. There is no
// "buy" tool, because an agent must never be the last thing standing between a
// buyer and their money — completing a purchase requires an approved intent,
// and approval happens on a surface the agent doesn't control.
//
// Everything here is executed by Axon, not the model provider, so it works on
// any agent regardless of which model it runs.

import type { LocalTool } from "./agentTools";
import { discoverBusiness, searchCatalog, createCheckout, hashLineItems, UcpError, type UcpLineItem } from "./ucp";
import {
  proposePurchase,
  getActiveMandate,
  getCommerceProfilePrivate,
  spentInPeriod,
  CommerceError,
} from "./commerce";

const SEARCH = "commerce_search_products";
const PROPOSE = "commerce_propose_purchase";

function asItems(raw: unknown): UcpLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => {
      const o = i as { product_id?: unknown; productId?: unknown; quantity?: unknown };
      const productId = typeof o.product_id === "string" ? o.product_id : typeof o.productId === "string" ? o.productId : null;
      const q = Number(o.quantity ?? 1);
      return productId ? { productId, quantity: Number.isFinite(q) && q > 0 ? Math.floor(q) : 1 } : null;
    })
    .filter((i): i is UcpLineItem => i !== null);
}

export function commerceTools(agentId: string, taskId?: string): LocalTool[] {
  return [
    {
      name: SEARCH,
      label: "commerce/search",
      description:
        "Search a business's live catalogue for real, purchasable products. `business_host` is the domain of a " +
        "store that supports the Universal Commerce Protocol (e.g. shop.example.com). Returns current titles, " +
        "prices and availability — use this rather than recalling products from memory.",
      inputSchema: {
        type: "object",
        properties: {
          business_host: { type: "string", description: "Domain of the UCP business to search." },
          query: { type: "string", description: "What to look for." },
          limit: { type: "number", description: "Max results (1-25, default 10)." },
        },
        required: ["business_host", "query"],
      },
      run: async (args) => {
        const host = String(args.business_host ?? "");
        const query = String(args.query ?? "").trim();
        if (!query) return "Error: query is required.";
        try {
          const profile = await discoverBusiness(host);
          const products = await searchCatalog(profile, query, Number(args.limit) || 10);
          if (products.length === 0) return `No products matched "${query}" at ${profile.host}.`;
          return [
            `${products.length} result(s) at ${profile.host}:`,
            ...products.map(
              (p) =>
                `- ${p.title} — ${p.price} ${p.currency}${p.availability ? ` (${p.availability})` : ""}\n` +
                `  product_id: ${p.id}${p.url ? `\n  ${p.url}` : ""}`,
            ),
          ].join("\n");
        } catch (err) {
          if (err instanceof UcpError) return `Error: ${err.message}`;
          throw err;
        }
      },
    },
    {
      name: PROPOSE,
      label: "commerce/propose",
      description:
        "Propose buying specific products for the buyer. This prices the order for real (tax and shipping " +
        "included) and puts it in front of the buyer for approval — it does NOT complete a purchase. Call it " +
        "once you have concrete product_ids from a catalogue search. Tell the buyer what you proposed and that " +
        "it is awaiting their approval.",
      inputSchema: {
        type: "object",
        properties: {
          business_host: { type: "string", description: "Domain of the UCP business holding the cart." },
          items: {
            type: "array",
            description: "Line items to buy.",
            items: {
              type: "object",
              properties: {
                product_id: { type: "string" },
                quantity: { type: "number" },
              },
              required: ["product_id"],
            },
          },
          summary: { type: "string", description: "One line the buyer will read when deciding, e.g. what and why." },
        },
        required: ["business_host", "items", "summary"],
      },
      run: async (args) => {
        const items = asItems(args.items);
        if (items.length === 0) return "Error: at least one item with a product_id is required.";

        const mandate = getActiveMandate(agentId);
        if (!mandate) {
          return "Error: this agent has no active spend mandate. Its owner must grant one before it can propose purchases.";
        }
        // Read the buyer's details for the checkout call only. They go straight
        // to the business and are never returned to the model.
        const buyer = getCommerceProfilePrivate(mandate.profileId);
        if (!buyer || buyer.status !== "active") {
          return "Error: the buyer's commerce profile is frozen or missing.";
        }

        try {
          const profile = await discoverBusiness(String(args.business_host ?? ""));
          const session = await createCheckout(profile, items, {
            contact: buyer.contact,
            address: buyer.address,
          });

          const { intent, preCleared } = proposePurchase({
            agentId,
            taskId,
            businessHost: profile.host,
            summary: String(args.summary ?? "").slice(0, 500),
            itemsHash: hashLineItems(profile.host, items),
            amount: session.total,
            currency: session.currency,
            checkoutId: session.checkoutId,
          });

          const remaining = mandate.maxPerPeriod - spentInPeriod(mandate);
          return [
            preCleared
              ? `Proposed — under the buyer's ${mandate.autoApproveUnder} ${mandate.currency} threshold, so they need only sign it. It has not been purchased.`
              : "Proposed — waiting on the buyer's approval. It has not been purchased.",
            `Total: ${session.total} ${session.currency} at ${profile.host}`,
            `Intent: ${intent.intentId}`,
            `Remaining this ${mandate.period}: ${remaining.toFixed(2)} ${mandate.currency}`,
          ].join("\n");
        } catch (err) {
          // A refused purchase is information the model should act on — a smaller
          // cart, a cheaper item — not a failed task.
          if (err instanceof CommerceError || err instanceof UcpError) return `Error: ${err.message}`;
          throw err;
        }
      },
    },
  ];
}
