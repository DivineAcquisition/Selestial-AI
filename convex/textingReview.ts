/**
 * Staff review of a texting onboarding case, from the staff console (docs/texting/02-case.md): the evidence
 * and discussion behind a request, Selestial's internal review of each evidence item, internal notes,
 * exceptions, assisted number journeys, and a read-only view of whether production is ready.
 *
 * Everything here needs the `onboarding.evidence` staff capability. Staff never act as the owner: they cannot
 * approve a recommendation, approve a public review copy, authorize a charge or submit. "Accepted for
 * Selestial review" is Selestial's own check; the screens never present it as the carriers' approval.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, type QueryCtx } from "./_generated/server";
import { staffMutation, staffQuery, type StaffAccess } from "./lib/builders";
import { notAllowed, notFound, userError } from "./lib/errors";
import { recordEvent } from "./lib/events";
import { checkPortability, countBrands, getMessagingProfile } from "./lib/messaging/telnyxAccount";
import { telnyxWebhookUrl } from "./lib/messaging/telnyx";
import { secretsConfigured } from "./lib/recruiter/secrets";
import { secondFactorAge, supportEnabled } from "./lib/support/access";
import { deploymentName, environment, PRODUCTION_DEPLOYMENTS, publicApiOrigin } from "./lib/environment";
import { capabilitiesOf } from "./lib/support/catalog";
import { literals } from "./lib/statuses";
import { activeConfig, currentEvidence, evidenceRows, syncRecommendations } from "./lib/texting/case";
import { EVIDENCE_PURPOSE_WORDS, EVIDENCE_PURPOSES, EVIDENCE_STATE_WORDS } from "./lib/texting/caseSchema";
import { evidenceLinksReady, signedEvidenceUrl } from "./lib/texting/evidence";
import { TUTORIALS } from "./lib/tutorials/catalog";
import { writeException } from "./textingCase";

const SYSTEM = { kind: "system" as const };

function requireCapability(ctx: StaffAccess) {
  if (!capabilitiesOf(ctx.staff).has("onboarding.evidence")) notAllowed();
}

async function setupById(ctx: QueryCtx, setupId: Id<"textingSetups">) {
  const setup = await ctx.db.get(setupId);
  if (!setup) notFound();
  return setup;
}

// ── The case ──────────────────────────────────────────────────────────────────────────────────────

/** The whole case behind one company's texting setup, as staff see it: internal notes and words included. */
export const caseFor = staffQuery({
  args: { setupId: v.id("textingSetups") },
  handler: async (ctx, args) => {
    requireCapability(ctx);
    const setup = await setupById(ctx, args.setupId);
    const rows = await evidenceRows(ctx, setup._id);
    const staffNames = new Map<string, string>();
    const nameOf = async (id: Id<"staff"> | undefined) => {
      if (!id) return null;
      if (!staffNames.has(id)) staffNames.set(id, (await ctx.db.get(id))?.name ?? "Staff");
      return staffNames.get(id)!;
    };
    const shape = async (row: Doc<"textingEvidence">) => ({
      id: row._id,
      key: row.key,
      version: row.version,
      purpose: row.purpose,
      purposeLabel: EVIDENCE_PURPOSE_WORDS[row.purpose].label,
      describes: row.describes,
      kind: row.kind,
      file: row.file ? { name: row.file.name, contentType: row.file.contentType, size: row.file.size } : null,
      url: row.url ?? null,
      links: row.links,
      visibility: row.visibility,
      state: row.state,
      stateLabel: EVIDENCE_STATE_WORDS[row.state],
      stateNote: row.stateNote ?? null,
      addedAt: row.addedAt,
      addedBy: row.addedBy.kind === "staff" ? `Staff: ${await nameOf(row.addedBy.staffId)}` : row.addedBy.supportSessionId ? "Selestial Support (session)" : "Owner",
      reviewedBy: await nameOf(row.reviewedBy),
      reviewedAt: row.reviewedAt ?? null,
      submitted: row.lockedIn,
      replacedAt: row.replacedAt ?? null,
      reviewCopy: row.reviewCopy ? { of: row.reviewCopy.of, exposure: row.reviewCopy.exposure, approvedAt: row.reviewCopy.approval?.at ?? null, path: row.reviewCopy.exposure === "approved" && row.reviewCopy.token ? `${publicApiOrigin() ?? ""}/texting-review/${row.reviewCopy.token}` : null } : null,
    });
    const notes = await ctx.db.query("textingNotes").withIndex("by_setup_created", (q) => q.eq("setupId", setup._id)).take(300);
    const exceptions = await ctx.db.query("textingExceptions").withIndex("by_setup_updated", (q) => q.eq("setupId", setup._id)).order("desc").take(100);
    const recs = await ctx.db.query("textingRecommendations").withIndex("by_setup_key", (q) => q.eq("setupId", setup._id)).take(300);
    const submissions = setup.requestId ? await ctx.db.query("textingSubmissions").withIndex("by_request_version", (q) => q.eq("requestId", setup.requestId!)).take(20) : [];
    return {
      setupId: setup._id,
      companyId: setup.companyId,
      revision: setup.revision,
      route: setup.numberRoute ?? "new_local",
      configVersion: setup.configVersion ?? 0,
      evidence: await Promise.all(currentEvidence(rows).map(shape)),
      history: await Promise.all(rows.filter((row) => row.replacedAt !== undefined).map(shape)),
      notes: await Promise.all(
        notes
          .filter((note) => note.status === "posted")
          .map(async (note) => ({ id: note._id, audience: note.audience, body: note.body, by: note.author.kind === "staff" ? `Staff: ${await nameOf(note.author.staffId)}` : note.author.staffId ? `Selestial Support: ${await nameOf(note.author.staffId)}` : "Owner", revisions: note.revisions.length, locked: note.lockedAt !== undefined, createdAt: note.createdAt })),
      ),
      exceptions: exceptions.map((row) => ({ ...row, id: row._id })),
      recommendations: recs.filter((row) => row.status !== "resolved").map((row) => ({ id: row._id, issue: row.issue, stage: row.stage, status: row.status, responsible: row.responsible, approval: row.approval, clarification: row.clarification?.question ?? null })),
      submissions: submissions.map((row) => ({ version: row.version, submittedAt: row.submittedAt, configVersion: row.configVersion ?? 0, evidence: row.evidence ?? [] })),
      purposes: EVIDENCE_PURPOSES.map((key) => ({ key, label: EVIDENCE_PURPOSE_WORDS[key].label })),
    };
  },
});

/**
 * A short-lived address for an evidence file, for staff reviewing the request. The company's activity shows
 * that Selestial review opened an evidence file (never the address). Staff-only items are opened the same way.
 */
export const fileLink = staffMutation({
  capability: "onboarding.evidence",
  args: { evidenceId: v.id("textingEvidence") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.evidenceId);
    if (!row?.file) notFound();
    const signed = await signedEvidenceUrl(row._id, Date.now());
    if (!signed) throw userError("Files can't be opened on this deployment yet: ACTION_LINK_SECRET or CONVEX_SITE_URL isn't set.");
    if (row.visibility === "company") await recordEvent(ctx, { companyId: row.companyId, type: "texting.evidence_opened", actor: SYSTEM, subject: { table: "companies", id: row.companyId }, data: { staffId: ctx.staff._id, purpose: row.purpose } });
    return { ...signed, name: row.file.name, contentType: row.file.contentType };
  },
});

/** Records Selestial's internal review of one evidence version. This is never the carriers' decision. */
export const reviewEvidence = staffMutation({
  capability: "onboarding.evidence",
  args: { evidenceId: v.id("textingEvidence"), state: v.union(v.literal("under_review"), v.literal("accepted_internal"), v.literal("needs_replacement")), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.evidenceId);
    if (!row) notFound();
    if (row.replacedAt) throw userError("A newer version of this item exists. Review the current one.");
    if (row.kind === "placeholder") throw userError("Nothing has been added to this item yet.");
    const note = args.note?.trim().slice(0, 500) || undefined;
    if (args.state === "needs_replacement" && !note) throw userError("Say what needs to change, in words the owner will read.");
    const now = Date.now();
    await ctx.db.patch(row._id, { state: args.state, stateNote: note, reviewedBy: ctx.staff._id, reviewedAt: now, ...(args.state !== "accepted_internal" && row.reviewCopy?.exposure === "approved" ? { reviewCopy: { ...row.reviewCopy, exposure: "withdrawn" as const } } : {}) });
    await recordEvent(ctx, { companyId: row.companyId, type: "texting.evidence_reviewed", actor: SYSTEM, subject: { table: "companies", id: row.companyId }, data: { staffId: ctx.staff._id, state: args.state } });
    await syncRecommendations(ctx, row.setupId);
    return null;
  },
});

/** A note from Selestial review: internal (staff only) or to the owner. */
export const addNote = staffMutation({
  capability: "onboarding.evidence",
  args: { setupId: v.id("textingSetups"), body: v.string(), internal: v.boolean(), exceptionId: v.optional(v.id("textingExceptions")), answers: v.optional(v.id("textingRecommendations")) },
  handler: async (ctx, args) => {
    const setup = await setupById(ctx, args.setupId);
    const body = args.body.trim();
    if (!body || body.length > 4000) throw userError("A note is 1 to 4,000 characters.");
    const now = Date.now();
    await ctx.db.insert("textingNotes", { companyId: setup.companyId, setupId: setup._id, audience: args.internal ? "internal" : "company", body, status: "posted", author: { kind: "staff", staffId: ctx.staff._id }, links: { exceptionId: args.exceptionId }, revisions: [], createdAt: now, updatedAt: now });
    if (args.answers && !args.internal) {
      const rec = await ctx.db.get(args.answers);
      if (rec && rec.setupId === setup._id && rec.status === "clarification") await ctx.db.patch(rec._id, { status: "open", nextAction: "Selestial answered in Evidence & notes. Apply it, edit it, or dismiss it.", updatedAt: now });
    }
    return null;
  },
});

const exceptionArgs = {
  setupId: v.id("textingSetups"),
  exceptionId: v.optional(v.id("textingExceptions")),
  category: v.optional(v.union(v.literal("business_details"), v.literal("consent_evidence"), v.literal("policy_pages"), v.literal("number"), v.literal("number_port"), v.literal("toll_free"), v.literal("carrier_correction"), v.literal("other"))),
  severity: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
  ownerWords: v.optional(v.string()),
  internalWords: v.optional(v.string()),
  ask: v.optional(v.object({ kind: v.union(v.literal("correction"), v.literal("evidence"), v.literal("information")), field: v.optional(v.string()), purpose: v.optional(literals(EVIDENCE_PURPOSES)) })),
  nextAction: v.optional(v.string()),
  blocker: v.optional(v.string()),
  canContinue: v.optional(v.string()),
  followUpInDays: v.optional(v.number()),
  state: v.optional(v.union(v.literal("waiting_owner"), v.literal("waiting_selestial"), v.literal("waiting_provider"), v.literal("resolved"))),
  resolution: v.optional(v.string()),
  assignToMe: v.optional(v.boolean()),
};

/** Opens, updates, resolves or reopens an onboarding exception, or asks the owner for a correction or evidence. */
export const exception = staffMutation({
  capability: "onboarding.evidence",
  args: exceptionArgs,
  handler: async (ctx, args) => {
    const setup = await setupById(ctx, args.setupId);
    const { setupId, assignToMe, ...rest } = args;
    void setupId;
    return writeException(ctx, setup, { ...rest, ...(assignToMe ? { assignTo: { kind: "staff" as const, staffId: ctx.staff._id } } : {}) }, { by: ctx.staff.name || "Staff", staffId: ctx.staff._id });
  },
});

// ── Assisted porting: eligibility only ────────────────────────────────────────────────────────────

/**
 * Checks with Telnyx whether the number on an owner's porting request can move. Creates no porting order,
 * signs nothing and moves nothing; the answer is written to the request's internal words and history.
 */
export const checkPortable = staffMutation({
  capability: "onboarding.evidence",
  args: { exceptionId: v.id("textingExceptions") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.exceptionId);
    if (!row || row.assisted?.route !== "port_existing" || !row.assisted.phoneNumber) throw userError("Only a request to bring an existing number can be checked.");
    await ctx.scheduler.runAfter(0, internal.textingReview.runPortability, { exceptionId: row._id, phoneNumber: row.assisted.phoneNumber, staffName: ctx.staff.name || "Staff" });
    return null;
  },
});

export const runPortability = internalAction({
  args: { exceptionId: v.id("textingExceptions"), phoneNumber: v.string(), staffName: v.string() },
  handler: async (ctx, args) => {
    const answer = await checkPortability(fetch, [args.phoneNumber]);
    const words = answer.ok ? (answer.value[0] ? (answer.value[0].portable ? `Telnyx says ${args.phoneNumber} can be moved${answer.value[0].fastPortable ? " (FastPort eligible)" : ""}. No order was created.` : `Telnyx says ${args.phoneNumber} can't be moved: ${answer.value[0].reason || "no reason given"}.`) : "Telnyx returned no answer for this number.") : `The eligibility check didn't run: ${answer.problem}`;
    await ctx.runMutation(internal.textingReview.portabilityChecked, { exceptionId: args.exceptionId, words, by: args.staffName });
    return null;
  },
});

export const portabilityChecked = internalMutation({
  args: { exceptionId: v.id("textingExceptions"), words: v.string(), by: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.exceptionId);
    if (!row) return null;
    const now = Date.now();
    await ctx.db.patch(row._id, { internalWords: [row.internalWords, `Eligibility: ${args.words}`].filter(Boolean).join("\n").slice(-1000), history: [...row.history, { at: now, state: row.state, words: "Eligibility checked with the provider.", by: args.by }].slice(-100), updatedAt: now });
    return null;
  },
});

// ── Production readiness ──────────────────────────────────────────────────────────────────────────

type Status = "configured" | "not_configured" | "failed" | "not_verified";
const set = (name: string) => Boolean(process.env[name]?.trim());

/**
 * What production has, from evidence on this deployment: settings present, live checks recorded, events
 * received. A setting merely being present is "configured" only where there is nothing more to check; a
 * provider is "configured" only after a recorded check passed. Reads only; nothing here calls a provider.
 */
export const readiness = staffQuery({
  args: {},
  handler: async (ctx) => {
    const rows: { key: string; label: string; status: Status; detail: string }[] = [];
    const add = (key: string, label: string, status: Status, detail: string) => rows.push({ key, label, status, detail });
    // Which backend this is, by the address Convex reports. A custom domain set as the client address must still read as production.
    const host = (value: string | undefined) => value?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") || "not set";
    const name = deploymentName();
    const env = environment();
    add("environment", "Production detection", env === "production" ? "configured" : "failed", env === "production" ? `This backend is ${name}, recognised as production. Client address reported: ${host(process.env.CONVEX_CLOUD_URL)}; HTTP address: ${host(process.env.CONVEX_SITE_URL)}.` : `This backend reports ${host(process.env.CONVEX_CLOUD_URL)} as its address and is treated as NOT production (${PRODUCTION_DEPLOYMENTS.join(", ")} is): email and texts go only to test recipients, Telnyx changes are refused and live payment keys are ignored.`);
    const checks = await ctx.db.query("telnyxChecks").withIndex("by_started").order("desc").take(10);
    const stepOf = (key: string) => {
      for (const check of checks) {
        const found = check.steps.find((row) => row.key === key);
        if (found) return { ...found, startedAt: check.startedAt, mode: check.mode ?? "full" };
      }
      return null;
    };
    const publicStep = stepOf("public_api");
    const origin = publicApiOrigin();
    if (!origin) add("public_api", "Public API address", "not_configured", "No public address for HTTP routes.");
    else if (!publicStep) add("public_api", "Public API address", "not_verified", `${origin} is shown for integration webhooks and future API and MCP access, but hasn't been checked yet. Run the read-only check.`);
    else add("public_api", "Public API address", publicStep.state === "passed" ? "configured" : "failed", publicStep.detail);
    const keyStep = stepOf("key");
    if (!set("TELNYX_API_KEY")) add("telnyx_api", "Telnyx API access", "not_configured", "TELNYX_API_KEY isn't set.");
    else if (!keyStep) add("telnyx_api", "Telnyx API access", "not_verified", "A key is set but no check has been recorded. Run the read-only check.");
    else add("telnyx_api", "Telnyx API access", keyStep.state === "passed" ? "configured" : "failed", `${keyStep.detail} (checked ${new Date(keyStep.at).toISOString().slice(0, 16).replace("T", " ")} UTC)`);
    const profileStep = stepOf("profile");
    if (!set("TELNYX_MESSAGING_PROFILE_ID")) add("messaging_profile", "Messaging profile and callbacks", "not_configured", "TELNYX_MESSAGING_PROFILE_ID isn't set.");
    else if (!profileStep) add("messaging_profile", "Messaging profile and callbacks", "not_verified", "Set, but not read from Telnyx yet.");
    else add("messaging_profile", "Messaging profile and callbacks", profileStep.state === "passed" ? "configured" : "failed", profileStep.detail);
    add("callback_url", "Registration callback address", telnyxWebhookUrl() ? "configured" : "not_configured", telnyxWebhookUrl() ? "Brands and campaigns are filed with a callback address." : "Neither TELNYX_WEBHOOK_URL nor CONVEX_SITE_URL is set; registrations are only polled.");
    const signed = await ctx.db.query("telnyxEvents").take(1);
    add("webhook_verification", "Callback signature verification", !set("TELNYX_PUBLIC_KEY") ? "not_configured" : signed.length ? "configured" : "not_verified", !set("TELNYX_PUBLIC_KEY") ? "TELNYX_PUBLIC_KEY isn't set, so every callback is refused." : signed.length ? "A signed 10DLC callback has been verified and recorded." : "The key is set; no signed 10DLC callback has been received yet to prove it.");
    add("tax_id_encryption", "Tax ID encryption", (await secretsConfigured()) ? "configured" : "not_configured", (await secretsConfigured()) ? "MAILBOX_TOKEN_KEY seals EINs." : "MAILBOX_TOKEN_KEY isn't set: saving an EIN is refused.");
    add("hosted_pages", "Hosted policy and sign-up pages", set("LINK_ORIGIN") && set("PUBLIC_FORM_SECRET") ? "configured" : "not_configured", `LINK_ORIGIN ${set("LINK_ORIGIN") ? "set" : "missing"}; PUBLIC_FORM_SECRET ${set("PUBLIC_FORM_SECRET") ? "set" : "missing"} (the Next.js app needs it too, which this check can't see).`);
    add("evidence_links", "Expiring evidence links", evidenceLinksReady() ? "configured" : "not_configured", evidenceLinksReady() ? "Evidence files open through signed addresses that expire within 15 minutes." : "ACTION_LINK_SECRET (32+ characters) or CONVEX_SITE_URL is missing: evidence files can't be opened.");
    const age = secondFactorAge(await ctx.auth.getUserIdentity().then((identity) => identity!));
    add("support_sessions", "Support-session sign-in claims", !supportEnabled() ? "not_configured" : age === null ? "failed" : "configured", !supportEnabled() ? "SUPPORT_ACCESS isn't on (the privacy notice must be updated first; see docs/operations/03-support-sessions.md)." : age === null ? "Your sign-in token has no fva claim, so every session start would be refused." : "Support is on, and your sign-in token carries the second-factor claim.");
    const settings = await ctx.db.query("tutorialSettings").take(500);
    const published = TUTORIALS.filter((tutorial) => (settings.find((row) => row.tutorialId === tutorial.id)?.state ?? tutorial.defaultState) === "published");
    const withMedia = published.filter((tutorial) => settings.find((row) => row.tutorialId === tutorial.id)?.media ?? tutorial.media);
    add("tutorials", "Tutorial publication and media", published.length ? "configured" : "not_configured", `${published.length} of ${TUTORIALS.length} tutorials published on this deployment, ${withMedia.length} with video. Read from this deployment's settings, not the repository defaults.`);
    const config = await activeConfig(ctx);
    add("deployment", "Schema and functions", "configured", `This check ran on this deployment, so its texting case functions are deployed. Forms configuration in force: ${config.version === 0 ? "built-in" : `version ${config.version}`}.`);
    return rows;
  },
});

/** A read-only Telnyx check: reads the key and the messaging profile (GET only). Files nothing, not even a mock. */
export const runReadOnlyCheck = staffMutation({
  capability: "onboarding.evidence",
  args: {},
  handler: async (ctx) => {
    const checkId = await ctx.db.insert("telnyxChecks", { mode: "read_only", startedAt: Date.now(), startedBy: ctx.staff._id, status: "running", phase: "account", attempts: 0, steps: [] });
    await ctx.scheduler.runAfter(0, internal.textingReview.readOnlyCheck, { checkId });
    return checkId;
  },
});

export const readOnlyCheck = internalAction({
  args: { checkId: v.id("telnyxChecks") },
  handler: async (ctx, args) => {
    const at = Date.now();
    const steps: { key: string; label: string; state: "passed" | "warning" | "failed" | "skipped"; detail: string; at: number }[] = [];
    const key = await countBrands(fetch);
    steps.push(key.ok ? { key: "key", label: "API key", state: "passed", detail: `Telnyx accepted the key (read only). The account has ${key.value} 10DLC brands.`, at } : { key: "key", label: "API key", state: "failed", detail: key.problem, at });
    const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID?.trim();
    if (key.ok && profileId) {
      const profile = await getMessagingProfile(fetch, profileId);
      steps.push(!profile.ok ? { key: "profile", label: "Messaging profile", state: "failed", detail: profile.problem, at } : { key: "profile", label: "Messaging profile", state: profile.value.enabled ? "passed" : "failed", detail: profile.value.enabled ? `"${profile.value.name ?? profileId}" is on; incoming texts go to ${profile.value.webhookUrl ?? "nowhere"}.` : "The messaging profile is turned off.", at });
    } else steps.push({ key: "profile", label: "Messaging profile", state: "skipped", detail: profileId ? "Skipped: the API key didn't work." : "TELNYX_MESSAGING_PROFILE_ID isn't set.", at });
    // The address people see must serve this backend's HTTP routes: an unknown review copy answers with this backend's own "Not found.".
    const origin = publicApiOrigin();
    if (origin) {
      try {
        const response = await fetch(`${origin}/texting-review/${"A".repeat(32)}`, { signal: AbortSignal.timeout(10_000) });
        const body = (await response.text()).trim();
        steps.push(body === "Not found." ? { key: "public_api", label: "Public API address", state: "passed", detail: `${origin} serves this backend's HTTP routes (webhooks, links, future API and MCP).`, at } : { key: "public_api", label: "Public API address", state: "failed", detail: `${origin} doesn't serve this backend's HTTP routes (it answered ${response.status}${body ? `: ${body.slice(0, 80)}` : ""}). In Convex › Custom Domains, point it at HTTP actions.`, at });
      } catch {
        steps.push({ key: "public_api", label: "Public API address", state: "failed", detail: `${origin} didn't answer.`, at });
      }
    }
    await ctx.runMutation(internal.textingReview.readOnlyDone, { checkId: args.checkId, steps, passed: steps.every((row) => row.state === "passed") });
    return null;
  },
});

export const readOnlyDone = internalMutation({
  args: { checkId: v.id("telnyxChecks"), steps: v.array(v.object({ key: v.string(), label: v.string(), state: v.union(v.literal("passed"), v.literal("warning"), v.literal("failed"), v.literal("skipped")), detail: v.string(), at: v.number() })), passed: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.checkId, { steps: args.steps, status: args.passed ? "passed" : "failed", phase: "done", finishedAt: Date.now() });
    return null;
  },
});
