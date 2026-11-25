/**
 * Selestial Founding Access (convex/lib/founding/offer.ts for the offer itself).
 *
 * What lives here, and what does not:
 *   - The shared enrollment window: activated once by staff, closed by the deadline, by capacity, or by staff.
 *   - Founding claims: the business answers from the public page, carried into the workspace.
 *   - The public, aggregate status the page shows: window timestamps, a verified count, places left.
 *   - The Owner's founding status inside the app, and the staff funnel.
 *
 * Billing is NOT here. Price, places, reservations, payment and entitlements are decided by the existing
 * early-user rule (convex/lib/billing/earlyOffer.ts) and Autumn's record (convex/billing.ts storeAccount).
 * A claim started on the page is a lead until Autumn shows the first founding payment succeeded.
 */
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { accountFor, billingState } from "./lib/billing/access";
import type { AutumnEnv } from "./lib/billing/autumn";
import { earlyOfferOn, eligibility, foundingCampaign, offerFor, ownerOffer, placesUsed } from "./lib/billing/earlyOffer";
import { ownerMutation, ownerQuery, publicQuery, serverMutation, signedInQuery, staffMutation, staffQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { checkedAttribution, checkedClaim, enrollmentState, FOUNDING_OFFER, platformName, SETUP_PRIORITY, TEAM_SIZES, windowFrom, type Priority } from "./lib/founding/offer";
import { factsOf, stateFact } from "./lib/setup/facts";
import { setupOf } from "./setup";
import { allow } from "./lib/rateLimit";
import { text } from "./lib/text";

const HOUR = 3_600_000;
export const CLAIMS_PER_VISITOR_PER_HOUR = 8;
export const CLAIMS_PER_HOUR = 400;

async function campaignRow(ctx: QueryCtx | MutationCtx): Promise<Doc<"foundingCampaigns"> | null> {
  return ctx.db
    .query("foundingCampaigns")
    .withIndex("by_offer", (q) => q.eq("offerId", FOUNDING_OFFER.id))
    .unique();
}

/**
 * Verified founding companies: unique companies whose first payment at the founding price Autumn's record
 * shows as succeeded (earlyOffers claimed, or ended after being claimed). One row per company and
 * environment, so a duplicate membership, a repeated webhook or a second checkout cannot add one twice.
 * Reservations, abandoned and failed checkouts, released places and companies staff marked as test, demo
 * or staff are never counted. Only the deployment's own billing environment is read, so a sandbox purchase
 * never reaches a production count.
 */
export async function verifiedFoundingCompanies(ctx: QueryCtx | MutationCtx, env: AutumnEnv): Promise<number> {
  let count = 0;
  for (const state of ["claimed", "ended"] as const) {
    const rows = await ctx.db
      .query("earlyOffers")
      .withIndex("by_env_state", (q) => q.eq("env", env).eq("state", state))
      .take(500);
    for (const row of rows) {
      if (row.claimedAt === undefined) continue;
      const company = await ctx.db.get(row.companyId);
      if (!company || company.excludeFromCounts || company.deletedAt !== undefined) continue;
      count += 1;
    }
  }
  return count;
}

// ── Public ───────────────────────────────────────────────────────────────────────────────────────

export type PublicFoundingStatus = {
  offer: { id: string; version: string; capacity: number; foundingMonthlyCents: number; foundingMonths: number; renewalMonthlyCents: number };
  campaign: { status: "draft" | "open" | "closed"; enrollmentStartsAt: number | null; enrollmentEndsAt: number | null; displayTimezone: string } | null;
  /** Whether a founding claim can be paid at all: billing is connected and the founding plan is switched on. */
  checkoutOn: boolean;
  /** Verified founding companies. Null when billing is not connected: the page then shows no number. */
  joined: number | null;
  /** The billing rule's own used-place count (claimed + ended + live reservations). Null when not connected. */
  placesUsed: number | null;
};

/**
 * What the Founding Access page shows: only aggregates and the shared window. No company, person or billing
 * record. The current time is NOT decided here (a cached query must not freeze the clock): the web server
 * applies `enrollmentState` with its own time (src/lib/founding/status.ts).
 */
export const status = publicQuery({
  args: {},
  handler: async (ctx): Promise<PublicFoundingStatus> => {
    const row = await campaignRow(ctx);
    const billing = billingState();
    const offer = {
      id: FOUNDING_OFFER.id,
      version: FOUNDING_OFFER.version,
      capacity: FOUNDING_OFFER.capacity,
      foundingMonthlyCents: FOUNDING_OFFER.billing.foundingMonthlyCents,
      foundingMonths: FOUNDING_OFFER.billing.foundingMonths,
      renewalMonthlyCents: FOUNDING_OFFER.billing.renewalMonthlyCents,
    };
    const campaign = row ? { status: row.status, enrollmentStartsAt: row.enrollmentStartsAt ?? null, enrollmentEndsAt: row.enrollmentEndsAt ?? null, displayTimezone: row.displayTimezone } : null;
    if (!billing.connected) return { offer, campaign, checkoutOn: false, joined: null, placesUsed: null };
    // Reservations count until they expire; the expiry is compared with the stored time here, which is safe:
    // the hourly sweep releases expired ones, so the figure is never more than an hour behind.
    const reserved = await ctx.db
      .query("earlyOffers")
      .withIndex("by_env_state", (q) => q.eq("env", billing.env).eq("state", "reserved"))
      .take(200);
    let used = reserved.length;
    for (const state of ["claimed", "ended"] as const) used += (await ctx.db.query("earlyOffers").withIndex("by_env_state", (q) => q.eq("env", billing.env).eq("state", state)).take(500)).length;
    return { offer, campaign, checkoutOn: earlyOfferOn(), joined: await verifiedFoundingCompanies(ctx, billing.env), placesUsed: used };
  },
});

export type StartClaimResult = { status: "started"; claimKey: string } | { status: "closed" } | { status: "invalid" } | { status: "limited" };

/**
 * Starts a founding claim from the public page. Only the Selestial web server can call it (it holds
 * PUBLIC_FORM_SECRET); it chooses the random claim key. Refused once enrollment is not open, so a page left
 * open past the deadline cannot start one. It records answers only: no account, no place, no price.
 */
export const startClaim = serverMutation({
  args: {
    claimKey: v.string(),
    companyName: v.string(),
    currentSoftware: v.string(),
    teamSize: v.string(),
    priority: v.string(),
    attribution: v.optional(v.object({ source: v.optional(v.string()), medium: v.optional(v.string()), campaign: v.optional(v.string()) })),
    visitorKey: v.string(),
  },
  handler: async (ctx, args): Promise<StartClaimResult> => {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(args.claimKey)) return { status: "invalid" };
    const answers = checkedClaim(args);
    if (!answers) return { status: "invalid" };
    const now = Date.now();
    const billing = billingState();
    const used = billing.connected ? await placesUsed(ctx, billing.env, now) : 0;
    if (enrollmentState(await foundingCampaign(ctx), used, now) !== "open") return { status: "closed" };
    const visitor = args.visitorKey.trim().slice(0, 128) || "unknown";
    if (!(await allow(ctx, `founding:visitor:${visitor}`, CLAIMS_PER_VISITOR_PER_HOUR, HOUR))) return { status: "limited" };
    if (!(await allow(ctx, "founding:all", CLAIMS_PER_HOUR, HOUR))) return { status: "limited" };
    const existing = await ctx.db
      .query("foundingClaims")
      .withIndex("by_key", (q) => q.eq("claimKey", args.claimKey))
      .unique();
    // The same key sent twice (a double submit) is the same claim.
    if (existing) return { status: "started", claimKey: existing.claimKey };
    const attribution = checkedAttribution(args.attribution);
    await ctx.db.insert("foundingClaims", {
      claimKey: args.claimKey,
      offerId: FOUNDING_OFFER.id,
      offerVersion: FOUNDING_OFFER.version,
      ...answers,
      ...(Object.keys(attribution).length ? { attribution } : {}),
      createdAt: now,
    });
    return { status: "started", claimKey: args.claimKey };
  },
});

// ── The person claiming ─────────────────────────────────────────────────────────────────────────

async function claimByKey(ctx: QueryCtx | MutationCtx, claimKey: string) {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(claimKey)) return null;
  return ctx.db
    .query("foundingClaims")
    .withIndex("by_key", (q) => q.eq("claimKey", claimKey))
    .unique();
}

/**
 * Before a company exists: the company name from the claim, so company setup starts filled in. Only the
 * person the claim is bound to (or anyone, while it is bound to nobody) sees it.
 */
export const claimPreview = signedInQuery({
  args: { claimKey: v.string() },
  handler: async (ctx, args) => {
    const claim = await claimByKey(ctx, args.claimKey);
    if (!claim || (claim.userId && claim.userId !== ctx.userId)) return null;
    return { companyName: claim.companyName };
  },
});

/**
 * Links a claim to the signed-in Owner and the company they chose, and copies the business answers onto
 * the company for setup. Idempotent: the same claim and company again changes nothing. A claim bound to
 * another person is not found. It grants nothing: the founding price is decided only at checkout.
 */
export const attachClaim = ownerMutation({
  args: { claimKey: v.string() },
  handler: async (ctx, args) => {
    const claim = await claimByKey(ctx, args.claimKey);
    const userId = ctx.member.userId;
    if (!claim || !userId || (claim.userId && claim.userId !== userId)) throw userError("That founding claim was not found. Start again from the Founding Access page.", "not_found");
    const now = Date.now();
    if (claim.companyId !== ctx.companyId) {
      await ctx.db.patch(claim._id, { userId, companyId: ctx.companyId, attachedAt: claim.attachedAt ?? now });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "founding.claim_attached", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { offerVersion: claim.offerVersion } });
    }
    // The answers seed setup once; an Owner who already has them (from an earlier claim) keeps their own.
    if (!ctx.company.foundingProfile) {
      await ctx.db.patch(ctx.companyId, { foundingProfile: { currentSoftware: claim.currentSoftware, teamSize: claim.teamSize, priority: claim.priority, offerVersion: claim.offerVersion } });
      await seedSetup(ctx, ctx.companyId, ctx.member._id, claim);
    }
    return null;
  },
});

/**
 * Carries the claim's answers into setup so the Owner is not asked again: the first priority (only while
 * setup is in progress and none is chosen), how many people clean, and the booking tool. A fact the Owner
 * already stated is never replaced.
 */
async function seedSetup(ctx: MutationCtx, companyId: Id<"companies">, memberId: Id<"members">, claim: Doc<"foundingClaims">) {
  const setup = await setupOf(ctx, companyId);
  const priority = SETUP_PRIORITY[claim.priority as Priority];
  if (setup && setup.status === "in_progress" && setup.priority === undefined && priority) await ctx.db.patch(setup._id, { priority, revision: setup.revision + 1 });
  const facts = await factsOf(ctx, companyId);
  const known = (key: string) => facts.some((row) => row.key === key);
  if (!known("scale.cleaners") && TEAM_SIZES.some(([value]) => value === claim.teamSize)) await stateFact(ctx, companyId, memberId, "scale.cleaners", claim.teamSize);
  const platform = platformName(claim.currentSoftware);
  if (!known("tools.current")) await stateFact(ctx, companyId, memberId, "tools.current", platform ? ["scheduling_software"] : claim.currentSoftware === "manual" ? ["spreadsheets", "calendar"] : ["scheduling_software"]);
  if (platform && !known("tools.other")) await stateFact(ctx, companyId, memberId, "tools.other", platform);
}

/**
 * For an Owner who came to founding access already signed in, without a claim from the page: the three
 * business answers, asked once inside the app. The company name is already known. It grants nothing.
 */
export const saveProfile = ownerMutation({
  args: { currentSoftware: v.string(), teamSize: v.string(), priority: v.string() },
  handler: async (ctx, args) => {
    const answers = checkedClaim({ companyName: ctx.company.name, ...args });
    if (!answers) throw userError("Choose an answer for each question.");
    const profile = { currentSoftware: answers.currentSoftware, teamSize: answers.teamSize, priority: answers.priority, offerVersion: FOUNDING_OFFER.version };
    await ctx.db.patch(ctx.companyId, { foundingProfile: profile });
    const now = Date.now();
    const claimId = await ctx.db.insert("foundingClaims", { claimKey: `app_${ctx.companyId}_${now}`, offerId: FOUNDING_OFFER.id, offerVersion: FOUNDING_OFFER.version, ...answers, userId: ctx.member.userId, companyId: ctx.companyId, attachedAt: now, createdAt: now });
    const claim = (await ctx.db.get(claimId))!;
    await seedSetup(ctx, ctx.companyId, ctx.member._id, claim);
    await recordEvent(ctx, { companyId: ctx.companyId, type: "founding.claim_attached", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { offerVersion: FOUNDING_OFFER.version, source: "app" } });
    return null;
  },
});

export type FoundingStep =
  | { kind: "claimed"; endsAt: number; setupStarted: boolean }
  | { kind: "processing" }
  | { kind: "ready_to_pay"; placesLeft: number }
  | { kind: "attention"; problem: string }
  | { kind: "not_eligible"; reason: "has_plan" | "held_before" | "paid_before" | "full" | "enrollment_closed" | "not_open" | "billing_off" };

/**
 * The Owner's founding status, in one of the four states the page words: access claimed, payment still
 * processing, ready to pay (setup can begin once it is paid), or something needs attention. Read only from
 * the billing rule and Autumn's copy, never from a browser return.
 */
export const mine = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const claim = await ctx.db
      .query("foundingClaims")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .first();
    const profile = ctx.company.foundingProfile ?? null;
    const billing = billingState();
    const answers = profile ?? (claim ? { currentSoftware: claim.currentSoftware, teamSize: claim.teamSize, priority: claim.priority, offerVersion: claim.offerVersion } : null);
    if (!billing.connected) return { answers, step: { kind: "not_eligible", reason: "billing_off" } as FoundingStep };
    const now = Date.now();
    const account = await accountFor(ctx, ctx.companyId, billing.env);
    const offer = await ownerOffer(ctx, ctx.companyId, billing.env, account, now);
    const setup = await ctx.db
      .query("migrations")
      .withIndex("by_company", (q) => q.eq("companyId", ctx.companyId))
      .first();
    if (offer.kind === "active") return { answers, step: { kind: "claimed", endsAt: offer.endsAt, setupStarted: setup !== null } as FoundingStep };
    if (offer.kind === "reserved") return { answers, step: { kind: "processing" } as FoundingStep };
    // A founding purchase that failed: its problem, in the words billing already wrote for the Owner.
    const latest = await ctx.db
      .query("billingIntents")
      .withIndex("by_company_created", (q) => q.eq("companyId", ctx.companyId))
      .order("desc")
      .first();
    if (latest && latest.kind === "plan_change" && (latest.stage === "submitting" || latest.stage === "payment_needed") && now - latest.updatedAt < 24 * HOUR) return { answers, step: { kind: "processing" } as FoundingStep };
    if (offer.kind === "available") {
      if (latest && latest.kind === "plan_change" && latest.stage === "failed" && latest.problem && now - latest.updatedAt < 24 * HOUR) return { answers, step: { kind: "attention", problem: latest.problem } as FoundingStep };
      return { answers, step: { kind: "ready_to_pay", placesLeft: offer.placesLeft } as FoundingStep };
    }
    const verdict = await eligibility(ctx, ctx.companyId, billing.env, account, now);
    const reason: Extract<FoundingStep, { kind: "not_eligible" }>["reason"] =
      verdict.reason === "off" ? "billing_off" : verdict.reason === "eligible" ? "billing_off" : verdict.reason;
    // Before the campaign is activated the founding offer is not open to claims, whatever billing allows.
    const campaign = await foundingCampaign(ctx);
    if (!campaign || campaign.status === "draft") return { answers, step: { kind: "not_eligible", reason: "not_open" } as FoundingStep };
    return { answers, step: { kind: "not_eligible", reason } as FoundingStep };
  },
});

// ── Selestial staff ──────────────────────────────────────────────────────────────────────────────

/**
 * Opens founding enrollment: sets the shared 90-day window from now. Once. A window that was ever set is
 * never restarted or moved by this, so a second call (or a redeploy, or a page load) cannot reset it.
 * Refused while the founding plan cannot be paid, so the page never invites claims checkout cannot honour.
 */
export const activate = staffMutation({
  capability: "billing.adjust",
  args: { confirmVersion: v.string() },
  handler: async (ctx, args) => {
    if (args.confirmVersion !== FOUNDING_OFFER.version) throw userError(`Confirm the offer version shown (${FOUNDING_OFFER.version}) to open enrollment.`);
    const billing = billingState();
    if (!billing.connected || !earlyOfferOn()) throw userError("The founding price can't be paid yet: connect billing and switch the early-user offer on (EARLY_OFFER=on) after pushing the operate_early plan to Autumn.");
    const row = await campaignRow(ctx);
    if (row?.enrollmentStartsAt !== undefined) throw userError("Founding enrollment was already opened. Its window is set once and can't be restarted.");
    const now = Date.now();
    const window = windowFrom(now);
    const fields = { offerVersion: FOUNDING_OFFER.version, status: "open" as const, ...window, displayTimezone: FOUNDING_OFFER.displayTimezone, activatedBy: ctx.staff._id, updatedAt: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("foundingCampaigns", { offerId: FOUNDING_OFFER.id, ...fields });
    return window;
  },
});

/** Closes enrollment before the deadline. Existing founding customers keep their terms; nothing reopens it. */
export const close = staffMutation({
  capability: "billing.adjust",
  args: { reason: v.string() },
  handler: async (ctx, args) => {
    const row = await campaignRow(ctx);
    if (!row || row.status !== "open") throw userError("Founding enrollment isn't open.");
    const reason = text(args.reason, "The reason", 300);
    if (reason.length < 5) throw userError("Say why enrollment is closing.");
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "closed", closedAt: now, closedBy: ctx.staff._id, closeReason: reason, updatedAt: now });
    return null;
  },
});

/** Marks a company as test, demo or staff, so no public count includes it. */
export const setExcludedFromCounts = staffMutation({
  capability: "billing.adjust",
  args: { companyId: v.id("companies"), excluded: v.boolean() },
  handler: async (ctx, args) => {
    const company = await ctx.db.get(args.companyId);
    if (!company) throw userError("That company was not found.", "not_found");
    await ctx.db.patch(args.companyId, { excludeFromCounts: args.excluded ? true : undefined });
    return null;
  },
});

/**
 * The internal funnel, each measure kept apart so the public label uses the right one:
 * leads (claims started) → accounts (claims linked to a company) → checkouts (places reserved at the
 * founding price) → verified founding claims (Autumn showed the first payment) → active founding subscriptions.
 */
export const funnel = staffQuery({
  args: {},
  handler: async (ctx) => {
    const billing = billingState();
    const env: AutumnEnv = billing.connected ? billing.env : "sandbox";
    const claims = await ctx.db.query("foundingClaims").take(2000);
    const offers: Doc<"earlyOffers">[] = [];
    for (const state of ["reserved", "claimed", "ended", "released"] as const) offers.push(...(await ctx.db.query("earlyOffers").withIndex("by_env_state", (q) => q.eq("env", env).eq("state", state)).take(500)));
    let active = 0;
    for (const row of offers) {
      if (row.state !== "claimed") continue;
      const account = await accountFor(ctx, row.companyId, env);
      if (account?.plan && account.subscription.endsAt === null) active += 1;
    }
    const campaign = await campaignRow(ctx);
    return {
      env,
      offerVersion: FOUNDING_OFFER.version,
      campaign: campaign ? { status: campaign.status, enrollmentStartsAt: campaign.enrollmentStartsAt ?? null, enrollmentEndsAt: campaign.enrollmentEndsAt ?? null, closeReason: campaign.closeReason ?? null } : null,
      leads: claims.length,
      accounts: claims.filter((claim) => claim.companyId !== undefined).length,
      checkoutsStarted: offers.length,
      verifiedClaims: await verifiedFoundingCompanies(ctx, env),
      activeSubscriptions: active,
    };
  },
});

/** For tests: the claim a key names. */
export const claimOf = internalQuery({
  args: { claimKey: v.string() },
  handler: async (ctx, args) => claimByKey(ctx, args.claimKey),
});

/** For tests and the founding page: the company's founding row in an environment. */
export const offerRowOf = internalQuery({
  args: { companyId: v.id("companies"), env: v.union(v.literal("sandbox"), v.literal("production")) },
  handler: async (ctx, args): Promise<Doc<"earlyOffers"> | null> => offerFor(ctx, args.companyId as Id<"companies">, args.env),
});
