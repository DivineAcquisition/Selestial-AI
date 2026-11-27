#!/usr/bin/env node
/**
 * Reads a sandbox company's plan subscription in Stripe TEST MODE and checks a retention discount the way
 * docs/billing/05-cancellation.md asks (section "Sandbox checks"). Read-only: it creates, changes and charges
 * nothing (Stripe's invoice preview creates no invoice). It refuses a live key.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/retention-sandbox-check.mjs <companyId> [expected next total in cents]
 *
 * Prints: the Stripe customer found from Autumn's id (company_<companyId>), the subscription's items and
 * discounts, each retention coupon's percent, duration and product restriction, and the next invoice's
 * subtotal, discount and total as Stripe previews it, line by line, so you can see the discount touches the
 * plan's base price only. With an expected total it exits 1 when Stripe's preview differs.
 */
const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
if (!/^(sk|rk)_test_/.test(key)) {
  console.error("Refusing to run: STRIPE_SECRET_KEY must be a TEST-mode key (sk_test_ or rk_test_). Never run checks against live customers.");
  process.exit(2);
}
const [companyId, expected] = process.argv.slice(2);
if (!companyId) {
  console.error("Usage: node scripts/retention-sandbox-check.mjs <companyId> [expected next total in cents]");
  process.exit(2);
}
const autumnId = `company_${companyId}`;

function encode(params, prefix = "") {
  const pairs = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? pairs.push(...encode(item, `${name}[${i}]`)) : pairs.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === "object") pairs.push(...encode(v, name));
    else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(v)}`);
  }
  return pairs;
}

async function stripe(method, path, params = {}) {
  const body = encode(params).join("&");
  const url = method === "GET" && body ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${key}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body: method === "POST" ? body : undefined });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json?.error?.message ?? ""}`);
  return json;
}

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const date = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : "—");

const customers = await stripe("GET", "/v1/customers/search", { query: `metadata['autumn_customer_id']:'${autumnId}' OR metadata['autumn_id']:'${autumnId}' OR metadata['customer_id']:'${autumnId}'` });
if (customers.data.length !== 1) {
  console.error(`Expected one Stripe customer for ${autumnId}, found ${customers.data.length}. Check which metadata key Autumn uses.`);
  process.exit(1);
}
const customer = customers.data[0];
console.log(`Customer ${customer.id} (metadata: ${JSON.stringify(customer.metadata)})`);

const subs = await stripe("GET", "/v1/subscriptions", { customer: customer.id, status: "all", expand: ["data.discounts"] });
const live = subs.data.filter((s) => !["canceled", "incomplete_expired", "incomplete"].includes(s.status));
if (live.length !== 1) {
  console.error(`Expected one live subscription, found ${live.length}.`);
  process.exit(1);
}
const sub = live[0];
const periodEnd = sub.current_period_end ?? sub.items.data[0]?.current_period_end;
console.log(`Subscription ${sub.id}: ${sub.status}, renews ${date(periodEnd)}, cancel at period end: ${sub.cancel_at_period_end}, schedule: ${sub.schedule ?? "none"}`);
for (const item of sub.items.data) console.log(`  item ${item.id}: ${usd(item.price.unit_amount ?? 0)} / ${item.price.recurring?.interval} × ${item.quantity}, product ${item.price.product}`);
for (const discount of sub.discounts ?? []) {
  const couponId = typeof discount === "string" ? null : (discount.coupon?.id ?? discount.source?.coupon?.id ?? discount.source?.coupon);
  if (!couponId) continue;
  const coupon = await stripe("GET", `/v1/coupons/${couponId}`, { expand: ["applies_to"] });
  console.log(`  discount ${discount.id}: coupon ${coupon.id} ${coupon.percent_off}% ${coupon.duration}${coupon.duration_in_months ? ` × ${coupon.duration_in_months} months` : ""}, applies to ${JSON.stringify(coupon.applies_to?.products ?? "everything")}, redeemed ${coupon.times_redeemed}/${coupon.max_redemptions ?? "∞"}, metadata ${JSON.stringify(coupon.metadata)}`);
  console.log(`    starts ${date(discount.start)}, ends ${date(discount.end)}`);
}

const preview = await stripe("POST", "/v1/invoices/create_preview", { customer: customer.id, subscription: sub.id });
console.log(`Next invoice (preview): subtotal ${usd(preview.subtotal)}, discounts ${usd((preview.total_discount_amounts ?? []).reduce((s, d) => s + d.amount, 0))}, total ${usd(preview.total)}`);
for (const line of preview.lines?.data ?? []) {
  const discounted = (line.discount_amounts ?? []).reduce((s, d) => s + d.amount, 0);
  console.log(`  ${line.description ?? line.id}: ${usd(line.amount)}${discounted ? `, discount ${usd(discounted)}` : ""}`);
}
if (expected !== undefined) {
  const want = Number(expected);
  const total = preview.total - (preview.tax ?? 0);
  if (total !== want) {
    console.error(`MISMATCH: Stripe previews ${usd(total)} before tax; expected ${usd(want)}.`);
    process.exit(1);
  }
  console.log(`OK: Stripe previews ${usd(total)} before tax, as expected.`);
}
