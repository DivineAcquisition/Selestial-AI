/**
 * The staff Telnyx check: is the live Telnyx account ready to take a business texting registration?
 *
 * It runs on the backend with the key production uses, and checks in order: the API key, the messaging
 * profile numbers are ordered onto (and where it sends texts), the callback address and signing key, number
 * search, then a mock A2P registration. The mock brand and mock campaign are filed through exactly the code a
 * real submission uses (the same brand body and the same campaignFor), read back with the same parsers, and
 * then deleted. Telnyx validates and stores mock filings but never sends them to the carriers, and the check
 * buys no number. Each phase is saved before the next starts, so running it again never files twice.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { staffMutation, staffQuery } from "./lib/builders";
import { userError } from "./lib/errors";
import { siteOrigin } from "./lib/dispatch/links";
import { campaignFor } from "./lib/messaging/campaign";
import { telnyxWebhookUrl } from "./lib/messaging/telnyx";
import { BRAND_READY, brandFailed, countBrands, createBrand, createCampaign, deleteBrand, deleteCampaign, findCampaigns, getBrand, getCampaign, getMessagingProfile, searchNumbers } from "./lib/messaging/telnyxAccount";
import { draftFor, type DraftInput } from "./lib/texting/drafts";
import { planFor, sampleFor, sampleKeys } from "./lib/texting/plan";
import { DRAFT_KEYS } from "./lib/texting/schema";

const SECOND = 1000;
const RUNNING_FOR = 15 * 60 * SECOND;
const CAMPAIGN_TRIES = 8;

type Step = Doc<"telnyxChecks">["steps"][number];
type Phase = Doc<"telnyxChecks">["phase"];

/** Starts a check. One at a time; only an admin, because it files (mock) registrations on Selestial's account. */
export const run = staffMutation({
  adminOnly: true,
  args: {},
  handler: async (ctx) => {
    const last = await ctx.db.query("telnyxChecks").withIndex("by_started").order("desc").first();
    if (last && last.status === "running" && Date.now() - last.startedAt < RUNNING_FOR) throw userError("A Telnyx check is already running. Its results appear here as it goes.");
    const checkId = await ctx.db.insert("telnyxChecks", { startedAt: Date.now(), startedBy: ctx.staff._id, status: "running", phase: "account", attempts: 0, steps: [] });
    await ctx.scheduler.runAfter(0, internal.telnyxCheck.execute, { checkId });
    return checkId;
  },
});

/** The latest checks, newest first. */
export const latest = staffQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("telnyxChecks").withIndex("by_started").order("desc").take(3);
    return rows.map((row) => ({ checkId: row._id, startedAt: row.startedAt, status: row.status, finishedAt: row.finishedAt ?? null, steps: row.steps }));
  },
});

export const row = internalQuery({
  args: { checkId: v.id("telnyxChecks") },
  handler: async (ctx, args) => ctx.db.get(args.checkId),
});

const stepValidator = v.object({ key: v.string(), label: v.string(), state: v.union(v.literal("passed"), v.literal("warning"), v.literal("failed"), v.literal("skipped")), detail: v.string(), at: v.number() });

/** Saves what a phase found and where the check goes next. */
export const record = internalMutation({
  args: {
    checkId: v.id("telnyxChecks"),
    steps: v.array(stepValidator),
    phase: v.optional(v.union(v.literal("account"), v.literal("brand"), v.literal("campaign"), v.literal("cleanup"), v.literal("done"))),
    attempts: v.optional(v.number()),
    brandId: v.optional(v.string()),
    campaignId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const check = await ctx.db.get(args.checkId);
    if (!check || check.status !== "running") return null;
    const steps = [...check.steps, ...args.steps];
    const done = args.phase === "done";
    await ctx.db.patch(check._id, {
      steps,
      ...(args.phase ? { phase: args.phase } : {}),
      ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
      ...(args.brandId ? { brandId: args.brandId } : {}),
      ...(args.campaignId ? { campaignId: args.campaignId } : {}),
      ...(done ? { status: steps.some((step) => step.state === "failed") ? ("failed" as const) : ("passed" as const), finishedAt: Date.now() } : {}),
    });
    return null;
  },
});

const step = (key: string, label: string, state: Step["state"], detail: string): Step => ({ key, label, state, detail: detail.slice(0, 600), at: Date.now() });

/** A test business, clearly named as one. It is only ever filed as a Telnyx mock brand. */
const TEST_NAME = "Selestial Check Cleaning";
const TEST_HANDLE = "selestial-check";

/** The registration a cleaning company would submit, built with the same drafts, plan and samples as the guided setup. */
function testRequest(brandId: string): Doc<"textingRequests"> {
  const origin = siteOrigin();
  const links = { privacy: `${origin}/b/${TEST_HANDLE}/legal/privacy`, terms: `${origin}/b/${TEST_HANDLE}/legal/texting`, signup: `${origin}/b/${TEST_HANDLE}/texts` };
  const activities = ["inquiry_replies", "booking_conversations", "job_offers", "arrival_reminders"];
  const input: DraftInput = { name: TEST_NAME, legalName: "Selestial Check Test LLC", supportEmail: "texting-check@selestial.io", supportPhone: "+15125550100", street: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", activities, marketingPerWeek: 2, links, places: ["booking_form", "team_onboarding"] };
  const plan = planFor(activities, "PRIVATE_PROFIT")!;
  const drafts = Object.fromEntries(DRAFT_KEYS.map((key) => [key, draftFor(key, input)]).filter(([, text]) => text));
  return {
    brand: { displayName: TEST_NAME, companyName: "Selestial Check Test LLC", phone: "+15125550100", street: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", email: "texting-check@selestial.io", website: "https://www.selestial.io", vertical: "PROFESSIONAL" },
    usecase: plan.usecase,
    subUsecases: plan.subUsecases,
    activities,
    privacyLink: links.privacy,
    termsLink: links.terms,
    signupLink: links.signup,
    drafts,
    samples: sampleKeys(activities).map((key) => sampleFor(key, TEST_NAME, {})),
    brandId,
  } as unknown as Doc<"textingRequests">;
}

export const execute = internalAction({
  args: { checkId: v.id("telnyxChecks") },
  handler: async (ctx, args) => {
    const check = await ctx.runQuery(internal.telnyxCheck.row, args);
    if (!check || check.status !== "running") return null;
    const save = (fields: { steps: Step[]; phase?: Phase; attempts?: number; brandId?: string; campaignId?: string }) => ctx.runMutation(internal.telnyxCheck.record, { checkId: args.checkId, ...fields });
    const next = async (delay = 0) => {
      await ctx.scheduler.runAfter(delay, internal.telnyxCheck.execute, args);
    };

    if (check.phase === "account") {
      const steps: Step[] = [];
      const key = await countBrands(fetch);
      if (!key.ok) {
        steps.push(step("key", "API key", "failed", `${key.problem} Production can't reach Telnyx until TELNYX_API_KEY is a working key from the account that holds the messaging profile.`));
        await save({ steps: [...steps, step("mock", "Mock registration", "skipped", "Skipped: the API key didn't work.")], phase: "done" });
        return null;
      }
      steps.push(step("key", "API key", "passed", `Telnyx accepted the key. The account has ${key.value} 10DLC ${key.value === 1 ? "brand" : "brands"}.`));

      const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();
      const callback = telnyxWebhookUrl();
      if (!profileId) steps.push(step("profile", "Messaging profile", "failed", "TELNYX_MESSAGING_PROFILE_ID isn't set, so a bought number wouldn't be put on any messaging profile."));
      else {
        const profile = await getMessagingProfile(fetch, profileId);
        if (!profile.ok) steps.push(step("profile", "Messaging profile", "failed", `The profile in TELNYX_MESSAGING_PROFILE_ID can't be read: ${profile.problem}`));
        else if (!profile.value.enabled) steps.push(step("profile", "Messaging profile", "failed", `"${profile.value.name ?? profileId}" is turned off in Telnyx.`));
        else if (callback && profile.value.webhookUrl !== callback) steps.push(step("profile", "Messaging profile", "warning", `"${profile.value.name ?? profileId}" sends incoming texts and delivery reports to ${profile.value.webhookUrl ?? "nowhere"}, not ${callback}. Replies, STOP and delivery status won't reach Selestial until it's changed in Telnyx.`));
        else steps.push(step("profile", "Messaging profile", "passed", `"${profile.value.name ?? profileId}" is on and sends incoming texts and delivery reports to Selestial.`));
      }
      steps.push(callback ? step("callbacks", "Registration updates", "passed", `Brands and campaigns are filed with ${callback} for status updates.`) : step("callbacks", "Registration updates", "warning", "No callback address (TELNYX_WEBHOOK_URL or CONVEX_SITE_URL): registrations are still checked every 30 minutes."));
      steps.push(process.env.TELNYX_PUBLIC_KEY?.trim() ? step("signing", "Callback signatures", "passed", "TELNYX_PUBLIC_KEY is set, so only signed Telnyx callbacks are accepted.") : step("signing", "Callback signatures", "failed", "TELNYX_PUBLIC_KEY isn't set, so every Telnyx callback is refused."));

      const numbers = await searchNumbers(fetch, { areaCode: "512", limit: 3 });
      steps.push(numbers.ok ? step("numbers", "Number search", numbers.value.length ? "passed" : "warning", numbers.value.length ? `Found ${numbers.value.length} local numbers in 512 that can text. Nothing was held or bought.` : "The search worked but found no numbers in 512 right now.") : step("numbers", "Number search", "failed", numbers.problem));
      await save({ steps, phase: "brand" });
      await next();
      return null;
    }

    if (check.phase === "brand") {
      const request = testRequest("");
      const brand = await createBrand(fetch, { entityType: "PRIVATE_PROFIT", displayName: request.brand.displayName, companyName: request.brand.companyName, ein: "123456789", phone: request.brand.phone, street: request.brand.street, city: request.brand.city, state: request.brand.state, postalCode: request.brand.postalCode, email: request.brand.email, website: request.brand.website, vertical: request.brand.vertical, mock: true, ...(telnyxWebhookUrl() ? { webhookURL: telnyxWebhookUrl()! } : {}) });
      if (!brand.ok) {
        await save({ steps: [step("brand", "Mock brand filed", "failed", `Telnyx refused the brand a real submission would send: ${brand.problem}`)], phase: "done" });
        return null;
      }
      await save({ steps: [step("brand", "Mock brand filed", "passed", `Telnyx accepted the brand (${brand.value.brandId}) built by the same code as a real submission.`)], phase: "campaign", brandId: brand.value.brandId, attempts: 0 });
      await next(5 * SECOND);
      return null;
    }

    if (check.phase === "campaign" && check.brandId) {
      const brand = await getBrand(fetch, check.brandId);
      const ready = brand.ok && BRAND_READY.has(brand.value.identityStatus ?? "");
      const read = brand.ok ? `${brand.value.identityStatus ?? "no identity status yet"}${brand.value.status ? `, ${brand.value.status}` : ""}` : brand.problem;
      if (brand.ok && brandFailed(brand.value)) {
        await save({ steps: [step("brand-read", "Brand read back", "failed", `The brand was read back but shows as failed (${read}). ${brand.value.failure ?? ""}`.trim())], phase: "cleanup" });
        await next();
        return null;
      }
      const campaign = await createCampaign(fetch, campaignFor(testRequest(check.brandId), { brandId: check.brandId, reference: `sel-check-${args.checkId}`, webhookURL: telnyxWebhookUrl() }));
      if (!campaign.ok) {
        // A brand still being verified can't take a campaign yet: wait and try again, a few times.
        if (!ready && check.attempts + 1 < CAMPAIGN_TRIES) {
          await save({ steps: [], attempts: check.attempts + 1 });
          await next(30 * SECOND);
          return null;
        }
        await save({ steps: [step("brand-read", "Brand read back", brand.ok ? "passed" : "failed", `Read back as ${read}.`), step("campaign", "Mock campaign filed", "failed", `Telnyx refused the campaign a real submission would send: ${campaign.problem}`)], phase: "cleanup" });
        await next();
        return null;
      }
      const readBack = await getCampaign(fetch, campaign.value.campaignId);
      await save({
        steps: [
          step("brand-read", "Brand read back", brand.ok ? "passed" : "warning", `Read back as ${read}.`),
          step("campaign", "Mock campaign filed", "passed", `Telnyx accepted the campaign (${campaign.value.campaignId}): ${testRequest(check.brandId).usecase} with the company's own privacy policy, terms, samples and replies.`),
          readBack.ok ? step("campaign-read", "Campaign read back", "passed", `Read back with status ${readBack.value.campaignStatus ?? "not set yet"}${readBack.value.referenceId ? `, reference ${readBack.value.referenceId}` : ""}.`) : step("campaign-read", "Campaign read back", "failed", readBack.problem),
        ],
        campaignId: campaign.value.campaignId,
        phase: "cleanup",
      });
      await next();
      return null;
    }

    // Cleanup: the mock filings are removed so the account holds only real registrations.
    const steps: Step[] = [];
    // Every campaign under the mock brand goes, including one whose filing answer may have been lost.
    const campaigns = check.brandId ? await findCampaigns(fetch, check.brandId) : null;
    const ids = [...new Set([...(check.campaignId ? [check.campaignId] : []), ...(campaigns?.ok ? campaigns.value.map((row) => row.campaignId) : [])])];
    for (const id of ids) {
      const gone = await deleteCampaign(fetch, id);
      steps.push(gone.ok ? step("cleanup-campaign", "Mock campaign removed", "passed", "Deleted from Telnyx.") : step("cleanup-campaign", "Mock campaign removed", "warning", `Couldn't delete ${id}: ${gone.problem} It's a mock and isn't sent to the carriers; it can be deleted in the Telnyx portal.`));
    }
    if (check.brandId) {
      const gone = await deleteBrand(fetch, check.brandId);
      steps.push(gone.ok ? step("cleanup-brand", "Mock brand removed", "passed", "Deleted from Telnyx.") : step("cleanup-brand", "Mock brand removed", "warning", `Couldn't delete ${check.brandId}: ${gone.problem} It's a mock and isn't sent to the carriers; it can be deleted in the Telnyx portal.`));
    }
    await save({ steps, phase: "done" });
    return null;
  },
});

export type { Id };
