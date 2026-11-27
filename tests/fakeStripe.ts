/**
 * A stand-in for the parts of Stripe's API Finance uses, for tests. It keeps accounts, payment intents
 * and refunds the way Stripe's documentation describes, replays a request made again with the same
 * Idempotency-Key, and can lose an answer the ways a network can: before Stripe acted, or after Stripe
 * acted and before the answer arrived (the case that must never become a second charge).
 */
type Intent = {
  id: string;
  account: string;
  amount: number;
  status: "requires_payment_method" | "processing" | "succeeded" | "canceled";
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error: { message: string } | null;
  fee: number | null;
  disputed: boolean;
};
type Refund = { id: string; account: string; payment_intent: string; amount: number; status: "pending" | "succeeded" | "failed" | "canceled"; metadata: Record<string, string> };

/** A plan subscription on Selestial's own Stripe account, as the stand-in keeps it. Times in seconds, as Stripe sends them. */
export type PlatformSub = {
  id: string;
  customer: string;
  status: string;
  cents: number;
  product: string;
  interval: string;
  currentPeriodEnd: number;
  anchor: number;
  cancelAtPeriodEnd: boolean;
  schedule: string | null;
  trialEnd: number | null;
  discounts: { id: string; coupon: string }[];
  metadata: Record<string, string>;
};

export type Loss = { path: RegExp; when: "before" | "after"; times?: number };

export function fakeStripe() {
  const state = {
    accounts: new Map<string, { id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; currently_due: string[]; disabled_reason: string | null; name: string }>(),
    intents: new Map<string, Intent>(),
    refunds: new Map<string, Refund>(),
    /** Invoices on the platform's own account (the Selestial plan), by id: what `GET /v1/invoices/:id` answers. */
    invoices: new Map<string, { id: string; status: "draft" | "open" | "paid" | "void" | "uncollectible"; customer: string }>(),
    replies: new Map<string, { status: number; body: unknown }>(),
    calls: [] as { method: string; path: string; key: string | null; account: string | null }[],
    losses: [] as Loss[],
    /**
     * Selestial's own account (the one Autumn charges plans through): customers with Autumn's id in their
     * metadata, their plan subscriptions, and the coupons put on them (convex/cancellation.ts).
     */
    platform: {
      customers: new Map<string, { id: string; metadata: Record<string, string> }>(),
      subscriptions: new Map<string, PlatformSub>(),
      coupons: new Map<string, { id: string; percent_off: number; duration: string; duration_in_months: number | null; applies_to: { products: string[] }; max_redemptions: number; metadata: Record<string, string> }>(),
    },
    /** New refunds start in this state. */
    refundStatus: "succeeded" as Refund["status"],
    seq: 0,
  };
  const next = (prefix: string) => `${prefix}_${(++state.seq).toString().padStart(6, "0")}`;

  function piBody(pi: Intent) {
    return {
      id: pi.id,
      object: "payment_intent",
      amount: pi.amount,
      amount_received: pi.status === "succeeded" ? pi.amount : 0,
      status: pi.status,
      client_secret: pi.client_secret,
      livemode: false,
      metadata: pi.metadata,
      last_payment_error: pi.last_payment_error,
      latest_charge:
        pi.status === "succeeded" || pi.status === "processing"
          ? { id: `ch_${pi.id}`, disputed: pi.disputed, balance_transaction: pi.fee === null ? null : { fee: pi.fee }, payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } }
          : null,
    };
  }

  function subBody(sub: PlatformSub) {
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customer,
      status: sub.status,
      livemode: false,
      currency: "usd",
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      billing_cycle_anchor: sub.anchor,
      trial_end: sub.trialEnd,
      schedule: sub.schedule,
      metadata: sub.metadata,
      // Newer API versions keep the period on the item; the code reads either.
      items: { data: [{ id: `si_${sub.id}`, quantity: 1, current_period_end: sub.currentPeriodEnd, price: { id: `price_${sub.product}`, unit_amount: sub.cents, currency: "usd", product: sub.product, recurring: { interval: sub.interval, interval_count: 1, usage_type: "licensed" } } }] },
      discounts: sub.discounts.map((row) => ({ id: row.id, object: "discount", coupon: { id: row.coupon }, source: { coupon: row.coupon } })),
    };
  }

  function handlePlatform(method: string, path: string, form: URLSearchParams): { status: number; body: unknown } | null {
    let match: RegExpMatchArray | null;
    const p = state.platform;
    if (method === "GET" && path === "/v1/customers/search") {
      const wanted = /'([^']+)'$/.exec(form.get("query") ?? "")?.[1];
      return { status: 200, body: { data: [...p.customers.values()].filter((c) => Object.values(c.metadata).includes(wanted ?? "-")) } };
    }
    if (method === "GET" && (match = path.match(/^\/v1\/customers\/(cus_\w+)$/))) {
      const customer = p.customers.get(match[1]);
      return customer ? { status: 200, body: { ...customer, object: "customer" } } : { status: 404, body: { error: { code: "resource_missing", message: "No such customer" } } };
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      return { status: 200, body: { data: [...p.subscriptions.values()].filter((sub) => sub.customer === form.get("customer")).map(subBody) } };
    }
    if ((match = path.match(/^\/v1\/subscriptions\/(sub_\w+)$/))) {
      const sub = p.subscriptions.get(match[1]);
      if (!sub) return { status: 404, body: { error: { code: "resource_missing", message: "No such subscription" } } };
      if (method === "POST") {
        const coupon = form.get("discounts[0][coupon]");
        if (coupon) {
          const known = p.coupons.get(coupon);
          if (!known) return { status: 400, body: { error: { code: "resource_missing", message: "No such coupon" } } };
          // A populated list replaces the subscription's discounts (Stripe's documented behavior).
          sub.discounts = [{ id: next("di"), coupon }];
        }
        for (const [key, value] of form) if (key.startsWith("metadata[")) sub.metadata[key.slice(9, -1)] = value;
      }
      return { status: 200, body: subBody(sub) };
    }
    if (method === "POST" && path === "/v1/coupons") {
      const id = next("coupon");
      const metadata: Record<string, string> = {};
      for (const [key, value] of form) if (key.startsWith("metadata[")) metadata[key.slice(9, -1)] = value;
      const coupon = { id, percent_off: Number(form.get("percent_off")), duration: form.get("duration") ?? "", duration_in_months: form.get("duration_in_months") ? Number(form.get("duration_in_months")) : null, applies_to: { products: form.getAll("applies_to[products][0]") }, max_redemptions: Number(form.get("max_redemptions")), metadata };
      p.coupons.set(id, coupon);
      return { status: 200, body: { ...coupon, object: "coupon" } };
    }
    return null;
  }

  function handle(method: string, path: string, form: URLSearchParams, account: string | null): { status: number; body: unknown } {
    let match: RegExpMatchArray | null;
    if (!account) {
      const platform = handlePlatform(method, path, form);
      if (platform) return platform;
    }
    if (method === "POST" && path === "/v1/accounts") {
      const id = next("acct");
      state.accounts.set(id, { id, charges_enabled: false, payouts_enabled: false, details_submitted: false, currently_due: ["external_account"], disabled_reason: null, name: form.get("business_profile[name]") ?? "" });
      return { status: 200, body: accountBody(id) };
    }
    if (method === "POST" && path === "/v1/account_links") return { status: 200, body: { url: `https://connect.stripe.com/setup/s/${next("link")}`, expires_at: Math.floor(Date.now() / 1000) + 300 } };
    if (method === "GET" && (match = path.match(/^\/v1\/accounts\/(acct_\w+)$/))) {
      return state.accounts.has(match[1]) ? { status: 200, body: accountBody(match[1]) } : { status: 403, body: { error: { message: "No access" } } };
    }
    if (method === "GET" && (match = path.match(/^\/v1\/invoices\/(in_\w+)$/))) {
      const invoice = state.invoices.get(match[1]);
      return invoice ? { status: 200, body: { ...invoice, object: "invoice" } } : { status: 404, body: { error: { code: "resource_missing", message: "No such invoice" } } };
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const id = next("pi");
      const metadata: Record<string, string> = {};
      for (const [key, value] of form) if (key.startsWith("metadata[")) metadata[key.slice(9, -1)] = value;
      const pi: Intent = { id, account: account ?? "", amount: Number(form.get("amount")), status: "requires_payment_method", client_secret: `${id}_secret_test`, metadata, last_payment_error: null, fee: null, disputed: false };
      state.intents.set(id, pi);
      return { status: 200, body: piBody(pi) };
    }
    if (method === "GET" && path === "/v1/payment_intents/search") {
      const query = form.get("query") ?? "";
      const wanted = /'([^']+)'$/.exec(query)?.[1];
      return { status: 200, body: { data: [...state.intents.values()].filter((pi) => pi.account === account && pi.metadata.selestial_payment === wanted).map(piBody) } };
    }
    if ((match = path.match(/^\/v1\/payment_intents\/(pi_\w+)(\/cancel)?$/))) {
      const pi = state.intents.get(match[1]);
      if (!pi || pi.account !== account) return { status: 404, body: { error: { message: "No such payment_intent" } } };
      if (method === "POST" && match[2]) {
        if (pi.status !== "requires_payment_method") return { status: 400, body: { error: { code: "payment_intent_unexpected_state", message: "Cannot cancel" } } };
        pi.status = "canceled";
      }
      return { status: 200, body: piBody(pi) };
    }
    if (method === "POST" && path === "/v1/refunds") {
      const pi = state.intents.get(form.get("payment_intent") ?? "");
      if (!pi || pi.account !== account || pi.status !== "succeeded") return { status: 400, body: { error: { code: "charge_not_refundable", message: "This payment can't be refunded." } } };
      const id = next("re");
      const refund: Refund = { id, account: account ?? "", payment_intent: pi.id, amount: Number(form.get("amount")), status: state.refundStatus, metadata: { selestial_refund: form.get("metadata[selestial_refund]") ?? "" } };
      state.refunds.set(id, refund);
      return { status: 200, body: { ...refund, object: "refund" } };
    }
    if (method === "GET" && path === "/v1/refunds") {
      return { status: 200, body: { data: [...state.refunds.values()].filter((r) => r.account === account && r.payment_intent === form.get("payment_intent")) } };
    }
    if (method === "GET" && (match = path.match(/^\/v1\/refunds\/(re_\w+)$/))) {
      const refund = state.refunds.get(match[1]);
      return refund && refund.account === account ? { status: 200, body: { ...refund, object: "refund" } } : { status: 404, body: { error: { message: "No such refund" } } };
    }
    return { status: 404, body: { error: { message: `Unknown route ${method} ${path}` } } };
  }

  function accountBody(id: string) {
    const a = state.accounts.get(id)!;
    return { id, object: "account", charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, details_submitted: a.details_submitted, business_profile: { name: a.name }, requirements: { currently_due: a.currently_due, past_due: [], disabled_reason: a.disabled_reason } };
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const key = headers.get("Idempotency-Key");
    const account = headers.get("Stripe-Account");
    const form = new URLSearchParams(method === "GET" ? url.search : String(init?.body ?? ""));
    state.calls.push({ method, path: url.pathname, key, account });
    const loss = state.losses.find((l) => l.path.test(`${method} ${url.pathname}`));
    if (loss) {
      loss.times = (loss.times ?? 1) - 1;
      if (loss.times <= 0) state.losses.splice(state.losses.indexOf(loss), 1);
      if (loss.when === "before") throw new TypeError("network error");
    }
    let reply: { status: number; body: unknown };
    if (key && state.replies.has(key)) reply = state.replies.get(key)!;
    else {
      reply = handle(method, url.pathname, form, account);
      if (key && reply.status < 500) state.replies.set(key, reply);
    }
    if (loss?.when === "after") throw new TypeError("connection reset after the request was sent");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };

  return {
    state,
    fetch,
    /** Stripe finished onboarding the account. */
    activate(accountId: string) {
      const a = state.accounts.get(accountId)!;
      Object.assign(a, { charges_enabled: true, payouts_enabled: true, details_submitted: true, currently_due: [] });
    },
    /** The customer paid in Stripe's form: the payment intent moves on, as Stripe would move it. */
    settle(intentId: string, status: "processing" | "succeeded" | "declined", fee = 501) {
      const pi = state.intents.get(intentId)!;
      if (status === "declined") {
        pi.status = "requires_payment_method";
        pi.last_payment_error = { message: "Your card was declined." };
      } else {
        pi.status = status;
        pi.last_payment_error = null;
        pi.fee = status === "succeeded" ? fee : null;
      }
    },
    /**
     * A plan subscription for a company on Selestial's own account, the way Autumn makes it: a Stripe customer
     * whose metadata names Autumn's customer id, and one monthly base price.
     */
    planSubscription(companyId: string, fields: { cents: number; periodEnd: number; product?: string; status?: string; interval?: string; discounts?: { id: string; coupon: string }[]; schedule?: string | null; cancelAtPeriodEnd?: boolean; trialEnd?: number | null; anchor?: number }) {
      const customerId = next("cus");
      state.platform.customers.set(customerId, { id: customerId, metadata: { autumn_id: `company_${companyId}` } });
      const id = next("sub");
      const sub: PlatformSub = { id, customer: customerId, status: fields.status ?? "active", cents: fields.cents, product: fields.product ?? `prod_${fields.cents}`, interval: fields.interval ?? "month", currentPeriodEnd: Math.floor(fields.periodEnd / 1000), anchor: Math.floor((fields.anchor ?? fields.periodEnd) / 1000), cancelAtPeriodEnd: fields.cancelAtPeriodEnd ?? false, schedule: fields.schedule ?? null, trialEnd: fields.trialEnd ?? null, discounts: fields.discounts ?? [], metadata: {} };
      state.platform.subscriptions.set(id, sub);
      return sub;
    },
    intentsFor(paymentId: string) {
      return [...state.intents.values()].filter((pi) => pi.metadata.selestial_payment === paymentId);
    },
  };
}
