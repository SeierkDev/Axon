// Agent checkout, from the owner's side.
//
// An agent with the `commerce` grant can search real businesses and propose a
// purchase. It has no tool that buys. Between the proposal and the charge sits
// one thing: a signature from the owner's wallet over a message naming this
// exact cart at this exact price.
//
// That signature is non-repudiable, which cuts both ways — it is proof you
// agreed, so signing something you did not read is the whole risk of this
// feature. Everything here is built so you never have to: `approve()` fetches
// the real authorisation, parses it, checks it against what you say you expect,
// and only then signs. State an expectation and a purchase that moved
// underneath you is refused instead of authorised.

import type {
  ApprovalRequest,
  ApproveOptions,
  ApproveResult,
  AutoApprovePolicy,
  CommerceProfile,
  CreateProfileOptions,
  GrantMandateOptions,
  ListPurchasesOptions,
  ParsedAuthorisation,
  PaymentOptionsView,
  PurchaseExpectation,
  PurchaseIntent,
  PurchasesView,
  SpendMandate,
  WatchHandle,
  WatchPurchasesOptions,
} from "./types";

type RequestFn = (
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
) => Promise<unknown>;

/**
 * A purchase that was stopped rather than made. `reason` is the machine-readable
 * cause, so callers can tell "the price moved" from "you have no budget left"
 * without matching on prose.
 */
export class CommerceRefusedError extends Error {
  readonly reason: string;
  readonly intentId?: string;
  constructor(message: string, reason: string, intentId?: string) {
    super(message);
    this.name = "CommerceRefusedError";
    this.reason = reason;
    this.intentId = intentId;
  }
}

const NUM = /^-?\d+(\.\d+)?$/;

/** The authorisation's fields, in the exact order the server writes them. */
const FIELDS = ["intent", "business", "items", "amount", "ceiling", "expires"] as const;
const HEADER = "Axon purchase authorisation";

/**
 * Read the authorisation the server will verify.
 *
 * Deliberately rigid: exactly the header and exactly these six fields, in this
 * order, once each. A lenient parser here would be the weak point of the whole
 * feature — search for a field and take the first hit, and a value carrying a
 * newline could shadow the real one, so a signature meant for £5 covers £5 000.
 * Nothing upstream can produce such a value today; this is what makes that not
 * matter.
 */
export function parseAuthorisation(message: string): ParsedAuthorisation {
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== HEADER) {
    throw new CommerceRefusedError(
      "this is not an Axon purchase authorisation — refusing to sign it",
      "UNRECOGNISED_MESSAGE",
    );
  }
  if (lines.length !== FIELDS.length + 1) {
    throw new CommerceRefusedError(
      `the authorisation has ${lines.length - 1} fields, expected ${FIELDS.length} — refusing to sign it`,
      "MALFORMED_MESSAGE",
    );
  }

  const values: Record<string, string> = {};
  FIELDS.forEach((name, i) => {
    const line = lines[i + 1];
    if (!line.startsWith(`${name}: `)) {
      throw new CommerceRefusedError(
        `expected '${name}' at line ${i + 2} of the authorisation — refusing to sign it`,
        "MALFORMED_MESSAGE",
      );
    }
    values[name] = line.slice(name.length + 2).trim();
  });

  const money = (name: string): { value: number; currency: string } => {
    const [amount, currency, ...rest] = values[name].split(/\s+/);
    if (!NUM.test(amount ?? "") || !currency || rest.length) {
      throw new CommerceRefusedError(
        `could not read the ${name} in the authorisation — refusing to sign it`,
        "MALFORMED_MESSAGE",
      );
    }
    return { value: Number(amount), currency: currency.toUpperCase() };
  };

  const amount = money("amount");
  const ceiling = money("ceiling");
  if (!values.intent || !values.business) {
    throw new CommerceRefusedError("the authorisation is missing its subject — refusing to sign it", "MALFORMED_MESSAGE");
  }
  if (Number.isNaN(Date.parse(values.expires))) {
    throw new CommerceRefusedError("the authorisation has no readable expiry — refusing to sign it", "MALFORMED_MESSAGE");
  }
  return {
    intentId: values.intent,
    business: values.business,
    itemsHash: values.items,
    amount: amount.value,
    currency: amount.currency,
    ceiling: ceiling.value,
    expiresAt: values.expires,
  };
}

/**
 * Hold an authorisation against what the caller believes they are approving.
 * Throws rather than returning false: the only safe default when a purchase does
 * not match its description is to not sign it.
 */
export function assertAuthorisationMatches(
  auth: ParsedAuthorisation,
  expect: PurchaseExpectation,
  intentId?: string,
): void {
  const refuse = (msg: string, reason: string): never => {
    throw new CommerceRefusedError(msg, reason, intentId ?? auth.intentId);
  };

  if (expect.currency && auth.currency !== expect.currency.toUpperCase()) {
    refuse(
      `this purchase is priced in ${auth.currency}, not the ${expect.currency.toUpperCase()} you expected — nothing was signed`,
      "CURRENCY_MISMATCH",
    );
  }
  if (expect.maxAmount != null && auth.amount > expect.maxAmount) {
    refuse(
      `this purchase is ${auth.amount.toFixed(2)} ${auth.currency}, above the ${expect.maxAmount.toFixed(2)} you expected — nothing was signed`,
      "OVER_EXPECTED_AMOUNT",
    );
  }
  if (expect.business) {
    const allowed = (Array.isArray(expect.business) ? expect.business : [expect.business]).map((h) =>
      h.trim().toLowerCase(),
    );
    if (!allowed.includes(auth.business.trim().toLowerCase())) {
      refuse(
        `this purchase is from ${auth.business}, which is not one you expected — nothing was signed`,
        "UNEXPECTED_BUSINESS",
      );
    }
  }
  if (Date.parse(auth.expiresAt) <= Date.now()) {
    refuse("this authorisation has already expired — nothing was signed", "EXPIRED");
  }
}

/**
 * Pull the machine-readable cause out of a failed request.
 *
 * The server refuses purchases for reasons the caller genuinely needs to branch
 * on — the price moved, the currency changed, the budget is committed elsewhere.
 * Those arrive as an API error with a `reason`, which is the same thing this
 * module's own guard produces, so they are worth presenting as the same type.
 * Duck-typed rather than imported: the client already imports this module.
 */
function asRefusal(err: unknown, intentId?: string): CommerceRefusedError | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { body?: unknown; details?: unknown; message?: string; name?: string };
  if (e.name !== "AxonApiError") return null;
  const from = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = (o as { reason?: unknown }).reason;
    return typeof r === "string" ? r : undefined;
  };
  const reason = from(e.body) ?? from(e.details);
  if (!reason) return null;
  const detail = (e.body as { purchaseError?: string } | undefined)?.purchaseError;
  return new CommerceRefusedError(detail ?? e.message ?? "the purchase was refused", reason, intentId);
}

export class CommerceApi {
  constructor(private readonly request: RequestFn) {}

  /** Every call goes through here so a refusal is a refusal, whoever made it. */
  private async call(
    method: string,
    path: string,
    opts?: { body?: unknown },
    intentId?: string,
  ): Promise<unknown> {
    try {
      return await this.request(method, path, opts);
    } catch (err) {
      const refusal = asRefusal(err, intentId);
      if (refusal) throw refusal;
      throw err;
    }
  }

  // ── Where orders go ────────────────────────────────────────────────────────

  /** Store a delivery destination. Encrypted at rest; never shown to an agent. */
  async createProfile(options: CreateProfileOptions): Promise<CommerceProfile> {
    return (await this.call("POST", "/api/commerce/profiles", { body: options })) as CommerceProfile;
  }

  async listProfiles(): Promise<CommerceProfile[]> {
    const res = (await this.call("GET", "/api/commerce/profiles")) as { profiles: CommerceProfile[] };
    return res.profiles;
  }

  /** Erase the personal data on a profile, keeping the purchase history intact. */
  async forgetProfile(profileId: string): Promise<{ profileId: string; forgotten: true }> {
    return (await this.call(
      "DELETE",
      `/api/commerce/profiles?id=${encodeURIComponent(profileId)}`,
    )) as { profileId: string; forgotten: true };
  }

  // ── What it may spend ──────────────────────────────────────────────────────

  /** Give an agent a budget. It must already hold the `commerce` grant. */
  async grantMandate(options: GrantMandateOptions): Promise<SpendMandate> {
    return (await this.call("POST", "/api/commerce/mandates", { body: options })) as SpendMandate;
  }

  async listMandates(): Promise<SpendMandate[]> {
    const res = (await this.call("GET", "/api/commerce/mandates")) as { mandates: SpendMandate[] };
    return res.mandates;
  }

  async revokeMandate(mandateId: string): Promise<{ mandateId: string; revoked: boolean }> {
    return (await this.call(
      "DELETE",
      `/api/commerce/mandates?id=${encodeURIComponent(mandateId)}`,
    )) as { mandateId: string; revoked: boolean };
  }

  /** Revoke every mandate at once and stop anything in flight. */
  async stopAllSpending(): Promise<{ stopped: true; revoked?: number }> {
    return (await this.call("POST", "/api/commerce/kill", { body: {} })) as {
      stopped: true;
      revoked?: number;
    };
  }

  // ── What it wants to buy ───────────────────────────────────────────────────

  async listPurchases(options: ListPurchasesOptions = {}): Promise<PurchasesView> {
    const q = new URLSearchParams();
    if (options.limit != null) q.set("limit", String(options.limit));
    if (options.status) q.set("status", options.status);
    if (options.refresh) q.set("refresh", "1");
    const qs = q.toString();
    return (await this.call("GET", `/api/commerce/intents${qs ? `?${qs}` : ""}`)) as PurchasesView;
  }

  /**
   * The purchases waiting on you. Asks for the largest page the server will
   * give: this drives `watch()` and `autoApprove()`, and a purchase that falls
   * off the end of a page is one nobody is ever shown.
   */
  async pending(): Promise<PurchaseIntent[]> {
    return (await this.listPurchases({ status: "proposed", limit: 200 })).intents;
  }

  /**
   * One purchase, by id. What a `purchase.proposed` webhook gives you is an
   * intentId, so this is the direct way to act on it — listing and searching
   * quietly depends on it being on the first page.
   */
  async getPurchase(intentId: string): Promise<PurchaseIntent> {
    return (await this.call(
      "GET",
      `/api/commerce/intents/${encodeURIComponent(intentId)}`,
      undefined,
      intentId,
    )) as PurchaseIntent;
  }

  /** The exact text the server will verify a signature against. */
  async getApprovalRequest(intentId: string): Promise<ApprovalRequest> {
    return (await this.call(
      "GET",
      `/api/commerce/intents/${encodeURIComponent(intentId)}/decision`,
      undefined,
      intentId,
    )) as ApprovalRequest;
  }

  /** Which payment handler this purchase needs, read live from the business. */
  async getPaymentOptions(intentId: string): Promise<PaymentOptionsView> {
    return (await this.call(
      "GET",
      `/api/commerce/intents/${encodeURIComponent(intentId)}/payment`,
      undefined,
      intentId,
    )) as PaymentOptionsView;
  }

  async decline(intentId: string): Promise<PurchaseIntent> {
    return (await this.call(
      "POST",
      `/api/commerce/intents/${encodeURIComponent(intentId)}/decision`,
      { body: { decision: "decline" } },
      intentId,
    )) as PurchaseIntent;
  }

  /**
   * Approve a purchase.
   *
   * With `sign`, the authorisation is fetched, parsed, checked against `expect`,
   * and only then signed — so the thing you authorise is the thing you were
   * shown. A mismatch throws `CommerceRefusedError` and nothing is signed.
   *
   * Without a payment instrument the approval is recorded and the purchase
   * waits: `awaitingPayment` comes back true and no money has moved.
   */
  async approve(intentId: string, options: ApproveOptions): Promise<ApproveResult> {
    if (!options.sign && !options.signature) {
      throw new CommerceRefusedError(
        "approving is signing — pass `sign` (a signer) or `signature` (one you made yourself)",
        "NO_SIGNER",
        intentId,
      );
    }
    if (options.sign && options.signature) {
      throw new CommerceRefusedError(
        "pass either `sign` or `signature`, not both",
        "AMBIGUOUS_SIGNER",
        intentId,
      );
    }

    let authorisation: ParsedAuthorisation | undefined;
    let signature = options.signature;

    // Read the real authorisation whenever there is anything to check it against
    // — including when the caller signed it elsewhere. Someone using a hardware
    // wallet or a custody service states the same bounds as everyone else, and
    // an `expect` that only bites on one of two code paths is worse than none:
    // it reads as a limit while enforcing nothing.
    if (options.sign || options.expect) {
      const request = await this.getApprovalRequest(intentId);
      authorisation = parseAuthorisation(request.message);

      // The server addressed this message to one intent. If that is not the one
      // being approved, something is wrong with the exchange itself — stop.
      if (authorisation.intentId !== intentId) {
        throw new CommerceRefusedError(
          `the authorisation is for ${authorisation.intentId}, not ${intentId} — nothing was approved`,
          "INTENT_MISMATCH",
          intentId,
        );
      }
      if (options.expect) assertAuthorisationMatches(authorisation, options.expect, intentId);

      if (options.sign) {
        signature = await options.sign(request.message);
        if (!signature) {
          throw new CommerceRefusedError("the signer returned no signature", "NO_SIGNATURE", intentId);
        }
      }
    }

    const res = (await this.call(
      "POST",
      `/api/commerce/intents/${encodeURIComponent(intentId)}/decision`,
      {
        body: {
          decision: "approve",
          signature,
          ...(options.paymentInstrument ? { paymentInstrument: options.paymentInstrument } : {}),
        },
      },
      intentId,
    )) as ApproveResult & { reason?: string; purchaseError?: string };

    // A 202 comes back as a normal body: signed and recorded, nothing charged.
    const awaitingPayment = res.reason === "NO_PAYMENT_INSTRUMENT" || (!options.paymentInstrument && !res.orderId);
    return { ...res, ...(authorisation ? { authorisation } : {}), ...(awaitingPayment ? { awaitingPayment: true } : {}) };
  }

  // ── Standing over it ───────────────────────────────────────────────────────

  /**
   * Call `onProposed` once per purchase an agent puts up. Each intent is handed
   * over a single time, so this can drive a notification, a queue, or a prompt
   * without a de-duplication table of your own.
   */
  watch(options: WatchPurchasesOptions): WatchHandle {
    let seen = new Set<string>();
    let stopped = false;
    let running = false;

    // A watcher runs for weeks. Anything thrown out of a poll has nowhere to go
    // from inside an interval — rethrowing it would surface as an unhandled
    // rejection and take the process down, which is a poor way to learn that a
    // notification failed. Report and keep watching.
    const report = (err: unknown) => {
      if (options.onError) options.onError(err);
      else console.error("[axon] watch: purchase poll failed —", err);
    };

    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const pending = await this.pending();
        for (const intent of pending) {
          if (stopped) break;
          if (seen.has(intent.intentId)) continue;
          seen.add(intent.intentId);
          try {
            await options.onProposed(intent);
          } catch (err) {
            // Handled-and-failed is not the same as handled. Forget it again so
            // the next poll retries: a store having a bad minute should not
            // cost a purchase its only chance of being dealt with. A handler
            // that keeps failing keeps being reported, which is the point.
            seen.delete(intent.intentId);
            report(err);
          }
        }
        // Forget anything no longer pending, so `seen` stays the size of the
        // queue rather than growing for the life of the process. An intent
        // never returns to `proposed`, so a forgotten one cannot come back.
        if (!stopped) {
          const live = new Set(pending.map((i) => i.intentId));
          seen = new Set([...seen].filter((id) => live.has(id)));
        }
      } catch (err) {
        report(err);
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), Math.max(1_000, options.intervalMs ?? 15_000));
    // A watcher keeps the process alive, like any other interval — otherwise a
    // script whose whole job is watching exits the moment it starts, having
    // watched nothing. Pass `keepAlive: false` when something else owns the
    // lifecycle (a server, a job runner) and this should not be what holds it
    // open. `stop()` releases it either way.
    if (options.keepAlive === false) {
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    void tick();

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Approve matching purchases without a human in the loop.
   *
   * Every bound is required. An auto-approver with an open bound is a blank
   * cheque signed with your own key, so this refuses to be constructed without
   * an amount, a currency, and an explicit list of businesses. Anything outside
   * the policy is left alone for you to decide, never declined on your behalf.
   */
  autoApprove(policy: AutoApprovePolicy): WatchHandle {
    if (!(policy.maxAmount > 0)) {
      throw new CommerceRefusedError("autoApprove needs a positive maxAmount", "NO_LIMIT");
    }
    if (!policy.allowedHosts?.length) {
      throw new CommerceRefusedError(
        "autoApprove needs an explicit allowedHosts list — it will not approve purchases from anywhere",
        "NO_ALLOWED_HOSTS",
      );
    }
    if (!policy.currency) {
      throw new CommerceRefusedError("autoApprove needs a currency", "NO_CURRENCY");
    }
    if (typeof policy.sign !== "function") {
      throw new CommerceRefusedError("autoApprove needs a signer", "NO_SIGNER");
    }

    const expect: PurchaseExpectation = {
      maxAmount: policy.maxAmount,
      currency: policy.currency,
      business: policy.allowedHosts,
    };

    return this.watch({
      intervalMs: policy.intervalMs,
      onError: policy.onError,
      onProposed: async (intent) => {
        try {
          let paymentInstrument;
          if (policy.paymentInstrument) {
            // Read the handlers before signing, so a purchase that cannot be
            // paid is skipped rather than left signed and stranded.
            const options = await this.getPaymentOptions(intent.intentId);
            paymentInstrument = await policy.paymentInstrument(intent, options);
          }
          const result = await this.approve(intent.intentId, {
            sign: policy.sign,
            expect,
            paymentInstrument,
          });
          await policy.onApproved?.(result);
        } catch (err) {
          if (err instanceof CommerceRefusedError) {
            // The policy said no. That answer will not change, so let it stand
            // and leave the purchase for its owner to decide.
            await policy.onSkipped?.(intent, err.reason);
            return;
          }
          // Anything else — a timeout, a 503, a store having a bad minute — is
          // not a decision. Let it out: watch() reports it through the same
          // onError and retries next poll, rather than quietly dropping a
          // purchase nobody said no to.
          throw err;
        }
      },
    });
  }
}
