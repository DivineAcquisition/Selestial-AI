/**
 * A stand-in for the parts of Square's API Finance uses, for tests (docs/finance/square.md). It keeps
 * merchants, their OAuth tokens, locations, payment links and their orders, payments and refunds the way
 * Square's documentation describes: a link makes a DRAFT order that turns OPEN when paid, deleting a link
 * cancels its order, a refund is matched to its payment by id, and a request made again with the same
 * idempotency key is answered with the first answer. It can also lose an answer the ways a network can:
 * before Square acted, or after Square acted and before the answer arrived.
 */
type Money = { amount: number; currency: string };
type Location = { id: string; name: string; status: "ACTIVE" | "INACTIVE"; currency: string; capabilities: string[] };
type Merchant = { id: string; business_name: string; country: string; locations: Location[]; revoked: boolean; refreshToken: string; accessTokens: Set<string> };
type Order = { id: string; location_id: string; reference_id: string; state: "DRAFT" | "OPEN" | "CANCELED"; line_items: { name: string; base_price_money: Money }[]; tenders: { id: string; payment_id: string }[]; total: number; merchant: string };
type Link = { id: string; version: number; order_id: string; url: string; description: string; merchant: string; redirect_url: string };
type Payment = { id: string; status: "COMPLETED" | "APPROVED" | "PENDING" | "FAILED" | "CANCELED"; order_id: string; location_id: string; amount: number; currency: string; fee: number | null; refunded: number; refund_ids: string[]; merchant: string };
type Refund = { id: string; status: "PENDING" | "COMPLETED" | "REJECTED" | "FAILED"; payment_id: string; amount: number; merchant: string; reason: string };

export type Loss = { path: RegExp; when: "before" | "after"; times?: number };

export function fakeSquare() {
  const state = {
    merchants: new Map<string, Merchant>(),
    /** One-time OAuth codes and the merchant each authorizes. */
    codes: new Map<string, string>(),
    links: new Map<string, Link>(),
    orders: new Map<string, Order>(),
    payments: new Map<string, Payment>(),
    refunds: new Map<string, Refund>(),
    replies: new Map<string, { status: number; body: unknown }>(),
    calls: [] as { method: string; path: string; key: string | null; token: string | null }[],
    losses: [] as Loss[],
    /** New refunds start in this state. */
    refundStatus: "COMPLETED" as Refund["status"],
    /** Access tokens expire this long after they are issued. */
    tokenLife: 30 * 24 * 3_600_000,
    seq: 0,
  };
  const next = (prefix: string) => `${prefix}${(++state.seq).toString().padStart(6, "0")}`;
  const iso = (ms: number) => new Date(ms).toISOString();

  function merchantFor(token: string | null): Merchant | null {
    if (!token) return null;
    for (const merchant of state.merchants.values()) if (!merchant.revoked && merchant.accessTokens.has(token)) return merchant;
    return null;
  }

  const unauthorized = { status: 401, body: { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "This request could not be authorized." }] } };
  const notFound = { status: 404, body: { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND", detail: "Not found." }] } };

  function paymentBody(p: Payment) {
    return {
      id: p.id,
      status: p.status,
      order_id: p.order_id,
      location_id: p.location_id,
      amount_money: { amount: p.amount, currency: p.currency },
      total_money: { amount: p.amount, currency: p.currency },
      ...(p.refunded ? { refunded_money: { amount: p.refunded, currency: p.currency } } : {}),
      ...(p.fee !== null ? { processing_fee: [{ type: "INITIAL", amount_money: { amount: p.fee, currency: p.currency } }] } : {}),
      receipt_url: `https://squareup.com/receipt/preview/${p.id}`,
      source_type: "CARD",
      card_details: { status: p.status === "FAILED" ? "FAILED" : "CAPTURED", card: { card_brand: "VISA", last_4: "1111" } },
      refund_ids: p.refund_ids,
    };
  }
  const refundBody = (r: Refund) => ({ id: r.id, status: r.status, payment_id: r.payment_id, amount_money: { amount: r.amount, currency: "USD" }, reason: r.reason });
  const linkBody = (l: Link) => ({ id: l.id, version: l.version, order_id: l.order_id, url: l.url, long_url: `${l.url}?long=1`, description: l.description });

  function handle(method: string, path: string, body: Record<string, unknown> | null, token: string | null, client: string | null): { status: number; body: unknown } {
    let match: RegExpMatchArray | null;
    if (method === "POST" && path === "/oauth2/token") {
      if (!body?.client_secret) return { status: 401, body: { message: "Client secret missing.", type: "unauthorized" } };
      if (body.grant_type === "authorization_code") {
        const merchantId = state.codes.get(String(body.code));
        if (!merchantId) return { status: 401, body: { message: "Authorization code is invalid or expired.", type: "unauthorized" } };
        state.codes.delete(String(body.code));
        const merchant = state.merchants.get(merchantId)!;
        merchant.revoked = false;
        const access = next("EAAAtok");
        merchant.accessTokens.add(access);
        return { status: 200, body: { access_token: access, token_type: "bearer", expires_at: iso(Date.now() + state.tokenLife), merchant_id: merchant.id, refresh_token: merchant.refreshToken } };
      }
      if (body.grant_type === "refresh_token") {
        const merchant = [...state.merchants.values()].find((m) => m.refreshToken === body.refresh_token);
        if (!merchant || merchant.revoked) return { status: 401, body: { message: "The refresh token is invalid.", type: "unauthorized" } };
        const access = next("EAAAtok");
        merchant.accessTokens.add(access);
        return { status: 200, body: { access_token: access, token_type: "bearer", expires_at: iso(Date.now() + state.tokenLife), merchant_id: merchant.id, refresh_token: merchant.refreshToken } };
      }
      return { status: 400, body: { message: "Unsupported grant.", type: "bad_request" } };
    }
    if (method === "POST" && path === "/oauth2/revoke") {
      if (!client) return unauthorized;
      const merchant = state.merchants.get(String(body?.merchant_id));
      if (merchant) {
        merchant.revoked = true;
        merchant.accessTokens.clear();
      }
      return { status: 200, body: { success: true } };
    }
    const merchant = merchantFor(token);
    if (!merchant) return unauthorized;
    if (method === "GET" && path === "/v2/merchants/me") return { status: 200, body: { merchant: { id: merchant.id, business_name: merchant.business_name, country: merchant.country, currency: "USD", status: "ACTIVE" } } };
    if (method === "GET" && path === "/v2/locations") return { status: 200, body: { locations: merchant.locations.map((l) => ({ ...l, merchant_id: merchant.id })) } };
    if (method === "POST" && path === "/v2/online-checkout/payment-links") {
      const order = body!.order as { location_id: string; reference_id: string; line_items: { name: string; base_price_money: Money }[] };
      const location = merchant.locations.find((l) => l.id === order.location_id);
      if (!location || location.status !== "ACTIVE") return { status: 400, body: { errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_LOCATION", detail: "The location can't take payments." }] } };
      const orderId = next("ORD");
      const total = order.line_items.reduce((s, li) => s + li.base_price_money.amount, 0);
      state.orders.set(orderId, { id: orderId, location_id: order.location_id, reference_id: order.reference_id, state: "DRAFT", line_items: order.line_items, tenders: [], total, merchant: merchant.id });
      const id = next("LNK");
      const link: Link = { id, version: 1, order_id: orderId, url: `https://square.link/u/${id}`, description: String(body!.description ?? ""), merchant: merchant.id, redirect_url: String((body!.checkout_options as { redirect_url?: string } | undefined)?.redirect_url ?? "") };
      state.links.set(id, link);
      return { status: 200, body: { payment_link: linkBody(link), related_resources: { orders: [{ id: orderId }] } } };
    }
    if (method === "GET" && path.startsWith("/v2/online-checkout/payment-links")) {
      return { status: 200, body: { payment_links: [...state.links.values()].filter((l) => l.merchant === merchant.id).map(linkBody) } };
    }
    if (method === "DELETE" && (match = path.match(/^\/v2\/online-checkout\/payment-links\/([^/]+)$/))) {
      const link = state.links.get(match[1]);
      if (!link || link.merchant !== merchant.id) return notFound;
      state.links.delete(link.id);
      const order = state.orders.get(link.order_id)!;
      if (order.state === "DRAFT") order.state = "CANCELED";
      return { status: 200, body: { id: link.id, cancelled_order_id: order.id } };
    }
    if (method === "GET" && (match = path.match(/^\/v2\/orders\/([^/]+)$/))) {
      const order = state.orders.get(match[1]);
      if (!order || order.merchant !== merchant.id) return notFound;
      return { status: 200, body: { order: { id: order.id, location_id: order.location_id, reference_id: order.reference_id, state: order.state, tenders: order.tenders.map((t) => ({ id: t.id, payment_id: t.payment_id, type: "CARD" })), total_money: { amount: order.total, currency: "USD" } } } };
    }
    if (method === "GET" && (match = path.match(/^\/v2\/payments\/([^/]+)$/))) {
      const payment = state.payments.get(match[1]);
      if (!payment || payment.merchant !== merchant.id) return notFound;
      return { status: 200, body: { payment: paymentBody(payment) } };
    }
    if (method === "POST" && path === "/v2/refunds") {
      const payment = state.payments.get(String(body!.payment_id));
      const amount = (body!.amount_money as Money).amount;
      if (!payment || payment.merchant !== merchant.id) return notFound;
      if (payment.status !== "COMPLETED") return { status: 400, body: { errors: [{ code: "PAYMENT_NOT_REFUNDABLE", detail: "Only completed payments can be refunded." }] } };
      if (amount > payment.amount - payment.refunded) return { status: 400, body: { errors: [{ code: "REFUND_AMOUNT_INVALID", detail: "The refund is more than what's left on the payment." }] } };
      const refund: Refund = { id: next("RFD"), status: state.refundStatus, payment_id: payment.id, amount, merchant: merchant.id, reason: String(body!.reason ?? "") };
      state.refunds.set(refund.id, refund);
      payment.refund_ids.push(refund.id);
      if (refund.status === "COMPLETED") payment.refunded += amount;
      return { status: 200, body: { refund: refundBody(refund) } };
    }
    if (method === "GET" && (match = path.match(/^\/v2\/refunds\/([^/]+)$/))) {
      const refund = state.refunds.get(match[1]);
      if (!refund || refund.merchant !== merchant.id) return notFound;
      return { status: 200, body: { refund: refundBody(refund) } };
    }
    return { status: 404, body: { errors: [{ code: "NOT_FOUND", detail: `No fake for ${method} ${path}` }] } };
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const client = auth.startsWith("Client ") ? auth.slice(7) : null;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const key = typeof body?.idempotency_key === "string" ? body.idempotency_key : null;
    const path = url.pathname;
    state.calls.push({ method, path, key, token });
    const loss = state.losses.find((l) => l.path.test(`${method} ${path}`) && (l.times ?? 1) > 0);
    if (loss?.when === "before") {
      loss.times = (loss.times ?? 1) - 1;
      throw new TypeError("network down");
    }
    const replayKey = key ? `${method} ${path} ${key}` : null;
    let reply = replayKey ? state.replies.get(replayKey) : undefined;
    if (!reply) {
      reply = handle(method, `${path}${url.search ? "" : ""}`, body, token, client);
      if (replayKey && reply.status < 500) state.replies.set(replayKey, reply);
    }
    if (loss?.when === "after") {
      loss.times = (loss.times ?? 1) - 1;
      throw new TypeError("connection reset after the request was sent");
    }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  return {
    state,
    fetch,
    /** A Square seller with one eligible location and one that can't take card payments. */
    addMerchant(id: string, name: string, locations?: Location[]) {
      state.merchants.set(id, {
        id,
        business_name: name,
        country: "US",
        locations: locations ?? [
          { id: `${id}-LOC1`, name: `${name} Main`, status: "ACTIVE", currency: "USD", capabilities: ["CREDIT_CARD_PROCESSING", "AUTOMATIC_TRANSFERS"] },
          { id: `${id}-LOC2`, name: `${name} Warehouse`, status: "ACTIVE", currency: "USD", capabilities: [] },
        ],
        revoked: false,
        refreshToken: `rt-${id}`,
        accessTokens: new Set(),
      });
    },
    /** The seller agreed on Square's page: the one-time code Square would send back. */
    authorize(merchantId: string) {
      const code = next("sq0cgb-");
      state.codes.set(code, merchantId);
      return code;
    },
    /** The seller ends Selestial's access from their Square account. */
    revoke(merchantId: string) {
      const merchant = state.merchants.get(merchantId)!;
      merchant.revoked = true;
      merchant.accessTokens.clear();
    },
    linkFor(orderId: string) {
      return [...state.links.values()].find((l) => l.order_id === orderId) ?? null;
    },
    /** A buyer pays an order on its checkout. A canceled order can't be paid. */
    pay(orderId: string, options: { status?: Payment["status"]; amount?: number; fee?: number | null } = {}) {
      const order = state.orders.get(orderId)!;
      if (order.state === "CANCELED") throw new Error("A canceled order can't be paid.");
      const payment: Payment = { id: next("PAY"), status: options.status ?? "COMPLETED", order_id: orderId, location_id: order.location_id, amount: options.amount ?? order.total, currency: "USD", fee: options.fee === undefined ? Math.round((options.amount ?? order.total) * 0.029) + 30 : options.fee, refunded: 0, refund_ids: [], merchant: order.merchant };
      state.payments.set(payment.id, payment);
      order.tenders.push({ id: payment.id, payment_id: payment.id });
      if (payment.status === "COMPLETED" || payment.status === "APPROVED") order.state = "OPEN";
      return payment;
    },
    /** A refund made in the Square Dashboard, without Selestial. */
    dashboardRefund(paymentId: string, amount: number) {
      const payment = state.payments.get(paymentId)!;
      const refund: Refund = { id: next("RFD"), status: "COMPLETED", payment_id: paymentId, amount, merchant: payment.merchant, reason: "Refunded at the counter" };
      state.refunds.set(refund.id, refund);
      payment.refund_ids.push(refund.id);
      payment.refunded += amount;
      return refund;
    },
    lose(loss: Loss) {
      state.losses.push({ times: 1, ...loss });
    },
    callsTo(pattern: RegExp) {
      return state.calls.filter((c) => pattern.test(`${c.method} ${c.path}`));
    },
  };
}
