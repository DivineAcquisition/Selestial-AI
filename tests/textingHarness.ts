/**
 * Shared by the texting tests: a stateful stand-in for Telnyx, and the steps an owner takes before
 * submitting. Kept outside convex/ so it is never bundled into a deployment.
 */
import { vi } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { T } from "./harness";

export const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 7)));
export const NUMBER = "+15125550142";
export const OTHER = "+15125550143";

type Call = { method: string; path: string; body: Record<string, unknown> | null };

/**
 * A stand-in for Telnyx's account API that keeps state like the real one: orders, brands and campaigns
 * exist once created, can be listed by their references, and answer "pending" until checked again. Every
 * call is recorded, so a test can see that nothing paid for happened twice.
 */
export function fakeTelnyx(options: { brand?: (checks: number) => Record<string, unknown>; campaign?: (checks: number) => string; assignment?: (checks: number) => string; available?: () => boolean; loseFirstOrderAnswer?: boolean; /** The number has left the account (a completed port-out). */ portedOut?: () => boolean; /** A write Telnyx refuses, by "METHOD /path". */ refuse?: (call: string) => boolean } = {}) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const orders: { id: string; reference: string; checks: number }[] = [];
  const campaigns: { campaignId: string; referenceId: string }[] = [];
  let brandMade = false;
  let lostOne = false;
  const released = new Set<string>();
  const unassigned = new Set<string>();
  const deletedCampaigns = new Set<string>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const count = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
  const fetcher = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.telnyx.com") return new Response("<html><body><h1>Alpha Cleaning</h1></body></html>", { status: 200 });
    const path = decodeURIComponent(url.pathname).replace("/v2", "");
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: `${path}${url.search ? decodeURIComponent(url.search) : ""}`, body });
    if (method !== "GET" && options.refuse?.(`${method} ${path}`)) return json({ errors: [{ code: "10007", title: "Unexpected error" }] }, 422);
    // Giving a number up: the account's own numbers, an assignment removed, a number or a campaign deleted. Each answers 404 once it is gone.
    if (method === "GET" && path === "/phone_numbers") {
      const number = url.searchParams.get("filter[phone_number]") ?? "";
      const bought = orders.some((row) => row.reference.endsWith(number.replace(/\D/g, "")));
      return json({ data: bought && !released.has(number) && !options.portedOut?.() ? [{ id: `num-${number.slice(-4)}`, phone_number: number, status: "active" }] : [] });
    }
    if (method === "DELETE" && path.startsWith("/phone_numbers/")) {
      const number = [NUMBER, OTHER].find((row) => `num-${row.slice(-4)}` === path.split("/")[2]);
      if (!number || released.has(number)) return json({ errors: [{ code: "10005", title: "Resource not found" }] }, 404);
      released.add(number);
      return json({ data: { id: path.split("/")[2], status: "deleted" } });
    }
    if (method === "DELETE" && path.startsWith("/10dlc/phone_number_campaigns/")) {
      const number = path.split("/")[3];
      if (unassigned.has(number)) return json({ errors: [{ code: "10005", title: "Resource not found" }] }, 404);
      unassigned.add(number);
      return json({ phoneNumber: number, assignmentStatus: "PENDING_DELETION" });
    }
    if (method === "DELETE" && path.startsWith("/10dlc/campaign/")) {
      const id = path.split("/")[3];
      if (deletedCampaigns.has(id)) return json({ errors: [{ code: "10005", title: "Resource not found" }] }, 404);
      deletedCampaigns.add(id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/available_phone_numbers") {
      const endsWith = url.searchParams.get("filter[phone_number][ends_with]");
      const all = [
        { phone_number: NUMBER, region_information: [{ region_type: "location", region_name: "AUSTIN" }, { region_type: "state", region_name: "TX" }], cost_information: { upfront_cost: "1.00", monthly_cost: "1.00", currency: "USD" }, features: [{ name: "sms" }, { name: "mms" }, { name: "voice" }] },
        { phone_number: OTHER, region_information: [{ region_type: "location", region_name: "AUSTIN" }, { region_type: "state", region_name: "TX" }], cost_information: { upfront_cost: "1.00", monthly_cost: "1.00", currency: "USD" }, features: [{ name: "sms" }] },
      ];
      if (endsWith) return json({ data: all.filter((row) => row.phone_number.endsWith(endsWith) && (options.available?.() ?? true)) });
      return json({ data: all });
    }
    if (method === "POST" && path === "/number_orders") {
      const order = { id: `order-${orders.length + 1}`, reference: String(body?.customer_reference), checks: 0 };
      orders.push(order);
      if (options.loseFirstOrderAnswer && !lostOne) {
        lostOne = true;
        throw new TypeError("network connection lost");
      }
      return json({ data: { id: order.id, status: "pending" } });
    }
    if (method === "GET" && path === "/number_orders") {
      const reference = url.searchParams.get("filter[customer_reference]");
      return json({ data: orders.filter((row) => row.reference === reference).map((row) => ({ id: row.id, status: "pending" })) });
    }
    if (method === "GET" && path.startsWith("/number_orders/")) {
      const order = orders.find((row) => row.id === path.split("/")[2])!;
      order.checks += 1;
      return json({ data: { id: order.id, status: order.checks === 1 ? "pending" : "success" } });
    }
    if (method === "POST" && path === "/10dlc/brand") {
      brandMade = true;
      return json({ brandId: "brand-1", identityStatus: null, status: "REGISTRATION_PENDING" });
    }
    if (method === "GET" && path === "/10dlc/brand") return json({ records: brandMade ? [{ brandId: "brand-1", displayName: body?.displayName ?? "Alpha Cleaning", email: "help@alpha.example" }] : [], page: 1, totalRecords: brandMade ? 1 : 0 });
    if (method === "GET" && path === "/10dlc/brand/brand-1") {
      const n = count("brand");
      return json({ brandId: "brand-1", ...(options.brand?.(n) ?? (n === 1 ? { identityStatus: null, status: "REGISTRATION_PENDING" } : { identityStatus: "VERIFIED", status: "OK" })) });
    }
    if (method === "PUT" && (path === "/10dlc/brand/brand-1" || path === "/10dlc/brand/brand-1/revet")) {
      counts.brand = 0;
      return json({ brandId: "brand-1", identityStatus: null, status: "REGISTRATION_PENDING" });
    }
    if (method === "POST" && path === "/10dlc/brand/brand-1/smsOtp") return json({ referenceId: "otp-1" });
    if (method === "PUT" && path === "/10dlc/brand/brand-1/smsOtp") return body?.otpPin === "123456" ? json({}) : json({ errors: [{ code: "10015", title: "Invalid OTP" }] }, 400);
    if (method === "POST" && path === "/10dlc/campaignBuilder") {
      const campaign = { campaignId: `campaign-${campaigns.length + 1}`, referenceId: String(body?.referenceId) };
      campaigns.push(campaign);
      return json({ ...campaign, campaignStatus: "TCR_PENDING" });
    }
    if (method === "GET" && path === "/10dlc/campaign") return json({ records: campaigns.map((row) => ({ ...row, campaignStatus: "TCR_PENDING" })), page: 1 });
    if (method === "GET" && path.startsWith("/10dlc/campaign/")) {
      const id = path.split("/")[3];
      const n = count(`campaign:${id}`);
      return json({ campaignId: id, campaignStatus: options.campaign?.(n) ?? (n === 1 ? "TCR_ACCEPTED" : "MNO_PROVISIONED"), status: "ACTIVE" });
    }
    if (method === "PUT" && path.startsWith("/10dlc/campaign/")) {
      counts[`campaign:${path.split("/")[3]}`] = 10;
      return json({ campaignId: path.split("/")[3], campaignStatus: "MNO_REJECTED" });
    }
    if (method === "POST" && path.endsWith("/appeal")) return json({});
    if (method === "POST" && path === "/10dlc/phone_number_campaigns") return json({ phoneNumber: body?.phoneNumber, campaignId: body?.campaignId, assignmentStatus: "PENDING_ASSIGNMENT" });
    if (method === "GET" && path.startsWith("/10dlc/phone_number_campaigns/")) return json({ phoneNumber: NUMBER, assignmentStatus: options.assignment?.(count("assignment")) ?? "ASSIGNED" });
    return json({ errors: [{ code: "10005", title: "Resource not found" }] }, 404);
  };
  const posts = () => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);
  return { fetcher, calls, posts, counts };
}

export async function settle(t: T) {
  for (let i = 0; i < 4; i += 1) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

export type As = ReturnType<T["withIdentity"]>;

export async function revision(as: As, companyId: Id<"companies">) {
  return (await as.query(api.textingSetup.view, { companyId }))!.setup.revision;
}

export const BUSINESS = { entityType: "PRIVATE_PROFIT", displayName: "Alpha Cleaning", legalName: "Alpha Cleaning LLC", street: "1 Main St", city: "Austin", state: "tx", postalCode: "78701", website: "alpha.example", supportEmail: "Help@Alpha.example", supportPhone: "(512) 555-0100" };

/** Everything an owner does before submitting: their business, what they'll send, permission and pages, a number. */
export async function prepare(t: T, as: As, companyId: Id<"companies">, change: { business?: Record<string, string>; activities?: string[]; taxId?: string | null } = {}) {
  await as.mutation(api.textingSetup.open, { companyId });
  await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), business: { ...BUSINESS, ...change.business } });
  if (change.taxId !== null) await as.mutation(api.textingSetup.setTaxId, { companyId, revision: await revision(as, companyId), taxId: change.taxId ?? "12-3456789" });
  await as.mutation(api.textingSetup.save, { companyId, revision: await revision(as, companyId), activities: change.activities ?? ["inquiry_replies", "job_offers", "arrival_reminders", "promotions"], places: ["booking_form", "team_onboarding"] });
  await as.mutation(api.textingSetup.publish, { companyId, revision: await revision(as, companyId) });
  await settle(t);
  const searchId = await as.mutation(api.texting.searchNumbersFor, { companyId, areaCode: "512" });
  await settle(t);
  await as.mutation(api.textingSetup.chooseNumber, { companyId, revision: await revision(as, companyId), searchId, phoneNumber: NUMBER });
  return searchId;
}

export async function submit(as: As, companyId: Id<"companies">) {
  const view = (await as.query(api.textingSetup.view, { companyId }))!;
  return as.mutation(api.textingSetup.submit, { companyId, revision: view.setup.revision, authorization: view.charges.wording });
}

