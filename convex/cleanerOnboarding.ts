/**
 * The guided onboarding a cleaner works through from the link their company sent (/c/portal/<token>).
 *
 * One read, `view`, gives the whole guided page: the company's name, logo and support contact, the steps in
 * order (lib/cleaners/steps.ts, the same function the owner's profile and Recruiter's reminders use), and
 * what each step needs to render. Opening it changes nothing. Each action below is one named portal action,
 * checked against the link (active, allowed, the step a task link names) and against the record, and
 * recorded. Nothing here completes a step on a person's behalf: a signature is the cleaner's typed name
 * against the exact approved version, a phone is verified only by the code sent to it, a guide only by its
 * explicit agreement, training only by what the page saw, and a tax document only by the worker's own
 * certification and a document actually made.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { CONSENT, recordHostedSignature } from "./lib/agreements/hostedSign";
import { sha256Bytes } from "./lib/agreements/hash";
import { markdownToPdf } from "./lib/agreements/pdf";
import { bookingSettingsOf } from "./lib/booking/settings";
import { portalMutation, portalQuery, type PortalAccess } from "./lib/builders";
import { syncHandoffRequirement } from "./lib/cleaners/handoff";
import { agreementForWorker, askOfficeToReview, completedModules, journeyOf, payoutOf, taxDocOf, trainingOf } from "./lib/cleaners/guided";
import { askedSupplies, fingerprint, PAY_METHOD_WORDS, partsOf, requiredModules, type PayMethod } from "./lib/cleaners/onboarding";
import { queueCleanerMessage } from "./lib/cleaners/outbox";
import { CODE_ATTEMPTS, CODE_LIFETIME, CODE_WINDOW, CODES_PER_WINDOW, codeHash, isVerified, maskAddress, newCode, VERIFIED_FOR } from "./lib/cleaners/portal";
import { agreementTypeFor, companyOnboarding } from "./lib/cleaners/records";
import { DAY } from "./lib/cleaners/settings";
import { cleanTin, sealTin, taxKeyConfigured, taxPlan, TIN_WORDS, unsealTin, US_STATES, W9_CERTIFICATION, w9Markdown } from "./lib/cleaners/tax";
import { ENGAGEMENT_WORDS } from "./lib/cleaners/enroll";
import { setPermission } from "./lib/compliance/permissions";
import { userError } from "./lib/errors";
import { recordEvent, type Actor } from "./lib/events";
import { payMethodWords } from "./lib/finance/teamPay";
import { sendablePhone } from "./lib/messaging/provider";
import { isEmail, optionalEmail, optionalText, text } from "./lib/text";
import { cleanerTextWording } from "./lib/texting/wording";

type Portal = MutationCtx & PortalAccess;

function cleanerOf(ctx: { cleaner: Doc<"cleaners"> | null }): Doc<"cleaners"> {
  if (!ctx.cleaner) throw userError("This link is for a subcontractor company, not a cleaner.", "not_allowed");
  return ctx.cleaner;
}

function actorOf(ctx: Portal): Actor {
  return { kind: "cleaner_portal", cleanerId: ctx.cleaner!._id, linkId: ctx.link._id };
}

const by = (ctx: Portal) => ({ kind: "cleaner" as const, linkId: ctx.link._id });

/** A task link opens one step; the keys are every requirement that step answers. */
function inScope(ctx: Portal, keys: string[]) {
  if (ctx.link.requirementKey && !keys.includes(ctx.link.requirementKey)) throw userError("This link is for a different step.", "not_allowed");
}

async function rowFor(ctx: Portal, key: string): Promise<Doc<"workerRequirements"> | null> {
  return (
    await ctx.db
      .query("workerRequirements")
      .withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleanerOf(ctx)._id).eq("key", key))
      .take(1)
  )[0] ?? null;
}

/** The worker's requirement of a kind, with its definition. Refused when it is not part of their onboarding. */
async function stepOf(ctx: Portal, kind: Doc<"requirementDefinitions">["kind"], key?: string) {
  const cleaner = cleanerOf(ctx);
  const { definitions, onboarding, readiness } = await journeyOf(ctx, ctx.company, cleaner, Date.now());
  const def = definitions.find((item) => item.kind === kind && (!key || item.key === key) && readiness.requirements.some((view) => view.key === item.key));
  if (!def) throw userError("That step is not part of your onboarding.");
  const row = await rowFor(ctx, def.key);
  if (!row) throw userError("That step is not part of your onboarding.");
  return { def, row, onboarding, cleaner };
}

async function markAccepted(ctx: Portal, row: Doc<"workerRequirements">, patch: Partial<Doc<"workerRequirements">>, note: string) {
  const now = Date.now();
  await ctx.db.patch(row._id, { status: "accepted", submittedAt: now, submittedBy: by(ctx), acceptedAt: now, reviewNote: note, waiver: undefined, updatedAt: now, ...patch });
  await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.requirement_accepted", actor: actorOf(ctx), subject: { table: "cleaners", id: row.cleanerId }, data: { key: row.key, via: "onboarding" } });
  await syncHandoffRequirement(ctx, cleanerOf(ctx), row.key, true, actorOf(ctx), note);
}

async function markForReview(ctx: Portal, row: Doc<"workerRequirements">, patch: Partial<Doc<"workerRequirements">>, what: { label: string; where: string }) {
  const now = Date.now();
  await ctx.db.patch(row._id, { status: "awaiting_review", submittedAt: now, submittedBy: by(ctx), reviewNote: undefined, updatedAt: now, ...patch });
  await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.requirement_submitted", actor: actorOf(ctx), subject: { table: "cleaners", id: row.cleanerId }, data: { key: row.key, via: "onboarding" } });
  await askOfficeToReview(ctx, ctx.company, cleanerOf(ctx), { key: row.key, ...what }, actorOf(ctx));
}

// ── The guided page ──────────────────────────────────────────────────────────────────────────────

export const view = portalQuery({
  args: { asOf: v.number() },
  handler: async (ctx, args) => {
    if (ctx.linkState !== "active" || !ctx.cleaner || ctx.cleaner.status === "ended") return null;
    const cleaner = ctx.cleaner;
    const now = args.asOf;
    const g = await journeyOf(ctx, ctx.company, cleaner, now);
    const { journey, onboarding, readiness, rows, windows } = g;
    const content = onboarding.content;
    const profile = (await bookingSettingsOf(ctx, ctx.company)).profile;
    const verified = isVerified(ctx.link, now);
    const rowOf = (key: string) => rows.find((row) => row.key === key);
    const keyOfKind = (kind: string) => readiness.requirements.find((view) => view.kind === kind)?.key;

    // Step 1: the agreement, its exact text, and their own signature once given.
    const a = g.agreement;
    const agreement = a
      ? {
          title: a.agreement.title,
          workflow: a.agreement.workflow,
          role: ENGAGEMENT_WORDS[cleaner.engagement],
          pay: cleaner.pay ? payMethodWords(cleaner.pay, ctx.company.payTiers) : null,
          markdown: a.version?.markdown ?? null,
          version: a.version?.version ?? null,
          hash: a.version?.hash ?? null,
          hosted: Boolean(a.signer),
          canSign: g.facts.agreementToSign,
          signedAt: a.signer?.signature?.at ?? null,
          typedName: a.signer?.signature?.typedName ?? null,
          others: a.request ? a.request.signers.filter((s) => s.email !== a.signer?.signerEmail).map((s) => ({ name: s.name, role: s.role, signed: s.status === "signed" })) : [],
          expiresAt: a.request?.expiresAt ?? null,
          consent: CONSENT,
        }
      : null;

    // Step 3: the checklist, as they answered it.
    const equipmentKey = keyOfKind("equipment");
    const suppliesRow = equipmentKey ? rowOf(equipmentKey) : undefined;

    // Step 6: their pay preference. Pay and tax details only after the one-time code.
    const payout = await payoutOf(ctx, ctx.companyId, cleaner._id);
    const tax = g.tax;

    // Step 7: training modules and what they completed.
    const progress = await trainingOf(ctx, ctx.companyId, cleaner._id);
    const trainingKey = keyOfKind("training");
    const floor = (trainingKey && onboarding.reack[trainingKey]) || 0;
    const done = completedModules(progress, floor);

    const guideOf = (key: string, guide: "jobGuide" | "expectations") => {
      const row = rowOf(key);
      return { key, ...content[guide], hash: fingerprint(content[guide]), agreedAt: readiness.requirements.find((view) => view.key === key)?.met ? (row?.acknowledged?.at ?? row?.acceptedAt ?? null) : null };
    };
    const guides = readiness.requirements
      .filter((view) => view.kind === "acknowledgment")
      .map((view) => {
        const def = g.definitions.find((item) => item.key === view.key);
        if (def?.guide) return guideOf(view.key, def.guide);
        // A company's own acknowledgment: its description is its words, agreed to exactly.
        return { key: view.key, title: view.label, intro: "", sections: [{ title: view.label, body: view.description ?? "" }], agreeLabel: "I have read this and I agree to it.", hash: null, words: view.description ?? "", imageUrl: undefined, imageAlt: undefined, agreedAt: view.met ? (rowOf(view.key)?.acknowledged?.at ?? null) : null };
      });

    return {
      company: {
        name: profile.displayName || ctx.company.name,
        logoUrl: profile.logo ? await ctx.storage.getUrl(profile.logo) : null,
        brandColor: profile.brandColor ?? null,
        support: { phone: content.support.phone ?? profile.phone ?? null, email: content.support.email ?? profile.email ?? null, hours: content.support.hours ?? null },
        welcome: content.welcome ?? null,
      },
      firstName: cleaner.name.trim().split(/\s+/)[0] || cleaner.name,
      focus: ctx.link.requirementKey ?? null,
      expiresAt: ctx.link.expiresAt,
      timezone: ctx.company.timezone,
      journey,
      readiness: { state: readiness.state, summary: readiness.summary },
      verified,
      agreement,
      contact: {
        phone: cleaner.phone ?? null,
        email: cleaner.email ?? null,
        phoneVerifiedAt: cleaner.phoneVerified && cleaner.phone && cleaner.phoneVerified.phone === sendablePhone(cleaner.phone) ? cleaner.phoneVerified.at : null,
        textsWording: cleanerTextWording(ctx.company.name),
        windows: windows.map((row) => ({ weekday: row.weekday, startMinute: row.startMinute, endMinute: row.endMinute })),
        areas: cleaner.serviceAreas,
        asksHours: readiness.requirements.some((view) => view.kind === "availability"),
        asksAreas: readiness.requirements.some((view) => view.kind === "service_areas"),
      },
      supplies: equipmentKey
        ? {
            key: equipmentKey,
            items: content.supplies.items.map((item) => ({ id: item.id, label: item.label, category: item.category, provider: item.provider, required: item.required, forServices: item.forServices })),
            answers: suppliesRow?.evidence?.supplies ?? {},
            submittedAt: suppliesRow?.acknowledged?.at ?? (suppliesRow?.evidence?.supplies ? (suppliesRow.submittedAt ?? null) : null),
            rule: content.supplies.rule,
          }
        : null,
      guides,
      payment: {
        key: keyOfKind("payment") ?? null,
        methods: content.payment.methods.map((method) => ({ id: method, ...PAY_METHOD_WORDS[method] })),
        schedule: content.payment.schedule,
        instructions: content.payment.instructions ?? null,
        pay: verified && cleaner.pay ? payMethodWords(cleaner.pay, ctx.company.payTiers) : null,
        current: payout ? { method: payout.method, status: payout.status, handle: verified ? (payout.handle ?? null) : null, label: PAY_METHOD_WORDS[payout.method].label } : null,
        tax: keyOfKind("tax")
          ? {
              form: g.taxPlan.form,
              status: tax?.status ?? (g.taxPlan.form === "w9" ? "awaiting_information" : "not_applicable"),
              needsWorker: g.facts.taxNeedsWorker,
              secureReady: g.taxKeyReady,
              legalName: verified ? (tax?.legalName ?? cleaner.name) : null,
              tinLast4: verified ? (tax?.tinLast4 ?? null) : null,
              tinType: tax?.tinType ?? null,
              certification: W9_CERTIFICATION,
            }
          : null,
      },
      training: {
        key: trainingKey ?? null,
        modules: content.training.modules.map((lesson) => {
          const row = progress.find((item) => item.moduleKey === lesson.key);
          return {
            ...lesson,
            sections: lesson.sections?.map((section) => ({ title: section.title, body: section.body, check: section.check ? { question: section.check.question, options: section.check.options } : null })),
            completedAt: done.has(lesson.key) ? (row?.completedAt ?? null) : null,
            watchedSeconds: row?.watchedSeconds ?? 0,
            sectionsRead: row && row.version >= floor ? (row.sectionsRead ?? []) : [],
          };
        }),
      },
      documents: readiness.requirements
        .filter((view) => journey.steps.some((step) => step.type === "document_upload" && step.keys.includes(view.key)))
        .map((view) => ({ key: view.key, label: view.label, description: view.description ?? null, state: view.state, files: rowOf(view.key)?.evidence?.files?.length ?? 0 })),
    };
  },
});

/** Their signed copy: the exact approved text with each signer's recorded signature. */
export const signedCopy = portalQuery({
  args: {},
  handler: async (ctx) => {
    if (ctx.linkState !== "active" || !ctx.cleaner) return null;
    const onboarding = await companyOnboarding(ctx, ctx.companyId);
    const a = await agreementForWorker(ctx, ctx.company, ctx.cleaner, onboarding);
    if (!a?.signer?.signature || !a.version || !a.request) return null;
    const links = await ctx.db
      .query("agreementSigningLinks")
      .withIndex("by_company_request", (q) => q.eq("companyId", ctx.companyId).eq("requestId", a.request!._id))
      .take(20);
    return {
      title: a.agreement.title,
      markdown: a.version.markdown,
      version: a.version.version,
      hash: a.version.hash,
      complete: a.agreement.workflow === "signed",
      signatures: a.request.signers.map((s) => {
        const sig = links.find((row) => row.signerEmail === s.email)?.signature;
        return { name: s.name, role: s.role, typedName: sig?.typedName ?? null, at: sig?.at ?? s.signedAt ?? null };
      }),
    };
  },
});

// ── Step 1: sign ─────────────────────────────────────────────────────────────────────────────────

export const signAgreement = portalMutation({
  action: "sign_agreement",
  args: { typedName: v.string(), hash: v.string(), agreed: v.boolean(), userAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { def, cleaner, onboarding } = await stepOf(ctx, "agreement");
    inScope(ctx, [def.key]);
    const a = await agreementForWorker(ctx, ctx.company, cleaner, onboarding, agreementTypeFor(def, cleaner.engagement, onboarding));
    if (!a?.request || !a.signer) throw userError("There is no agreement waiting for your signature here. The office will send it.");
    const result = await recordHostedSignature(ctx, { link: a.signer, request: a.request, agreement: a.agreement }, { typedName: args.typedName, hash: args.hash, agreed: args.agreed, userAgent: args.userAgent, via: "worker_portal" });
    if (!result.already) await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.agreement_signed", actor: actorOf(ctx), subject: { table: "cleaners", id: cleaner._id }, data: { agreementId: a.agreement._id, version: a.request.version, complete: result.completed } });
    if (result.completed) await syncHandoffRequirement(ctx, cleaner, def.key, true, actorOf(ctx), "Signed in Selestial by every signer.");
    else if (!result.already) await askOfficeToReview(ctx, ctx.company, cleaner, { key: def.key, label: "Agreement countersignature", where: `They signed ${a.agreement.title}. Open their profile in Team › Cleaners and countersign it.` }, actorOf(ctx));
    return { complete: result.completed };
  },
});

// ── Step 2: verify the phone and confirm details ─────────────────────────────────────────────────

/** Sends a code to the number they give (the one on file, or a corrected one). Only its hash is kept. */
export const sendPhoneCode = portalMutation({
  action: "verify_phone",
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const cleaner = cleanerOf(ctx);
    inScope(ctx, ["contact", "availability", "service_areas"]);
    const phone = sendablePhone(text(args.phone, "Mobile number", 40));
    if (!phone) throw userError("Enter a mobile number that can receive texts, with its area code.");
    const now = Date.now();
    const recent = await ctx.db
      .query("portalCodes")
      .withIndex("by_link", (q) => q.eq("linkId", ctx.link._id).gt("createdAt", now - CODE_WINDOW))
      .take(10);
    if (recent.length >= CODES_PER_WINDOW) throw userError("Several codes were sent just now. Wait a few minutes, then ask for a new one.", "limit");
    const code = newCode();
    const codeId = await ctx.db.insert("portalCodes", { companyId: ctx.companyId, linkId: ctx.link._id, purpose: "phone", to: phone, codeHash: await codeHash(ctx.link._id, code), channel: "sms", expiresAt: now + CODE_LIFETIME, attempts: 0, createdAt: now });
    const message = await queueCleanerMessage(
      ctx,
      { company: ctx.company, cleaner, channel: "sms", to: { sms: phone }, purpose: "verification_code", subject: `Your ${ctx.company.name} code`, body: `${ctx.company.name}: your code is {code}. It works for 10 minutes. Do not share it.`, dedupeKey: `portal.phone:${codeId}`, actor: actorOf(ctx) },
      { code },
    );
    await ctx.db.patch(codeId, { messageId: message._id });
    if (message.status === "not_sent") throw userError(`We could not text a code: ${message.problem ?? "texting is not set up"} You can confirm your details for the office to check instead.`);
    return { sentTo: maskAddress("sms", phone) };
  },
});

export const verifyPhone = portalMutation({
  action: "verify_phone",
  args: { code: v.string(), email: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const cleaner = cleanerOf(ctx);
    inScope(ctx, ["contact", "availability", "service_areas"]);
    const now = Date.now();
    const latest = (
      await ctx.db
        .query("portalCodes")
        .withIndex("by_link", (q) => q.eq("linkId", ctx.link._id))
        .order("desc")
        .take(10)
    ).find((row) => row.purpose === "phone");
    if (!latest || latest.usedAt !== undefined || latest.expiresAt <= now || !latest.to) throw userError("That code has expired. Ask for a new one.");
    if (latest.attempts >= CODE_ATTEMPTS) throw userError("Too many tries. Ask for a new code.", "limit");
    await ctx.db.patch(latest._id, { attempts: latest.attempts + 1 });
    if ((await codeHash(ctx.link._id, args.code.replace(/\D/g, ""))) !== latest.codeHash) throw userError(latest.attempts + 1 >= CODE_ATTEMPTS ? "That code is not right, and that was the last try. Ask for a new code." : "That code is not right. Check the latest text and try again.");
    await ctx.db.patch(latest._id, { usedAt: now });
    // They proved they hold this number: it is the number on file now, everywhere in Selestial.
    const changed = sendablePhone(cleaner.phone) !== latest.to;
    await ctx.db.patch(cleaner._id, { phone: latest.to, phoneVerified: { phone: latest.to, at: now }, updatedAt: now });
    // Holding the phone is also what unlocks pay and tax details on this link for a while.
    await ctx.db.patch(ctx.link._id, { verifiedUntil: now + VERIFIED_FOR });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.phone_verified", actor: actorOf(ctx), subject: { table: "cleaners", id: cleaner._id }, data: { changed } });
    const email = optionalEmail(args.email);
    const emailChanged = (email ?? "") !== (cleaner.email ?? "") && email !== undefined;
    const row = await rowFor(ctx, "contact");
    if (row && row.status !== "accepted" && row.status !== "waived") {
      const { definitions } = await journeyOf(ctx, ctx.company, cleaner, now);
      const def = definitions.find((item) => item.key === "contact");
      if (emailChanged || def?.officeReview) await markForReview(ctx, row, { evidence: { text: emailChanged ? `New email: ${email}` : "Phone verified by code." } }, { label: "Contact details", where: emailChanged ? "Their phone is verified; check the new email in their profile." : "Their phone is verified; confirm the details in their profile." });
      else await markAccepted(ctx, row, {}, "Phone verified by a code sent to it.");
    } else if (emailChanged && row) {
      await ctx.db.patch(row._id, { evidence: { ...(row.evidence ?? {}), text: `New email: ${email}` }, updatedAt: now });
      await askOfficeToReview(ctx, ctx.company, cleaner, { key: "contact", label: "New email", where: `They gave a new email (${email}). Update it in their profile.` }, actorOf(ctx));
    }
    return { verified: true, emailPending: emailChanged };
  },
});

/** Agreeing to work texts is the person's own act, kept apart from proving they hold the phone. */
export const workTexts = portalMutation({
  action: "confirm_contact",
  args: { agree: v.boolean() },
  handler: async (ctx, args) => {
    const cleaner = cleanerOf(ctx);
    if (!cleaner.phone) throw userError("Add a mobile number first.");
    await setPermission(ctx, {
      companyId: ctx.companyId,
      recipient: { kind: "cleaner", id: cleaner._id },
      channel: "sms",
      category: "operational",
      status: args.agree ? "granted" : "withdrawn",
      source: "onboarding",
      disclosureText: cleanerTextWording(ctx.company.name),
      evidence: "Given by the cleaner in their onboarding.",
      recordedBy: { kind: "recipient" },
      at: Date.now(),
      actor: actorOf(ctx),
    });
    return null;
  },
});

// ── Step 3: supplies ─────────────────────────────────────────────────────────────────────────────

/** A truthful checklist, missing items and all, completes the step. What it holds up is the company's rule. */
export const submitSupplies = portalMutation({
  action: "submit_supplies",
  args: { answers: v.record(v.string(), v.union(v.literal("have"), v.literal("missing"))) },
  handler: async (ctx, args) => {
    const { def, row, onboarding } = await stepOf(ctx, "equipment");
    inScope(ctx, [def.key]);
    const asked = askedSupplies(onboarding.content);
    const answers: Record<string, "have" | "missing"> = {};
    for (const item of asked) {
      const answer = args.answers[item.id];
      if (answer !== "have" && answer !== "missing") throw userError(`Answer every item, including "${item.label}". Saying you don't have something is fine.`);
      answers[item.id] = answer;
    }
    const acknowledged = { words: "supplies checklist", at: Date.now(), version: onboarding.version, hash: partsOf(onboarding.content).equipment };
    const missing = asked.filter((item) => answers[item.id] === "missing").length;
    if (row.status === "accepted" && !def.officeReview) {
      await ctx.db.patch(row._id, { evidence: { ...(row.evidence ?? {}), supplies: answers }, acknowledged, updatedAt: Date.now() });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.supplies_updated", actor: actorOf(ctx), subject: { table: "cleaners", id: row.cleanerId }, data: { have: asked.length - missing, missing } });
    } else if (def.officeReview) {
      await markForReview(ctx, row, { evidence: { ...(row.evidence ?? {}), supplies: answers }, acknowledged }, { label: "Supplies checklist", where: `They have ${asked.length - missing} of ${asked.length} items. Review it in their profile.` });
    } else {
      await markAccepted(ctx, row, { evidence: { ...(row.evidence ?? {}), supplies: answers }, acknowledged }, "Checklist submitted by the cleaner.");
    }
    return { have: asked.length - missing, missing };
  },
});

// ── Steps 4 and 5: guides ────────────────────────────────────────────────────────────────────────

/** An explicit agreement to the exact guide shown. Opening a guide records nothing. */
export const acknowledgeGuide = portalMutation({
  action: "acknowledge",
  args: { key: v.string(), hash: v.string(), agreed: v.boolean() },
  handler: async (ctx, args) => {
    const { def, row, onboarding } = await stepOf(ctx, "acknowledgment", args.key);
    inScope(ctx, [def.key]);
    if (!def.guide) throw userError("This step is agreed to with its own words.");
    if (!args.agreed) throw userError("Tick the box to agree first.");
    const guide = onboarding.content[def.guide];
    if (args.hash !== fingerprint(guide)) throw userError("This guide changed since the page opened. Read it again, then agree.");
    const now = Date.now();
    await markAccepted(ctx, row, { acknowledged: { words: guide.agreeLabel, at: now, version: onboarding.version, hash: args.hash }, expiresAt: def.validForDays ? now + def.validForDays * DAY : undefined }, `Agreed by the cleaner to version ${onboarding.version}.`);
    return null;
  },
});

// ── Step 6: pay and tax ──────────────────────────────────────────────────────────────────────────

function requireVerified(ctx: Portal) {
  if (!isVerified(ctx.link, Date.now())) throw userError("For your security, verify with a code first.", "not_allowed");
}

/** How they would like to be paid. A preference, confirmed by the office before it is used. */
export const setPayout = portalMutation({
  action: "set_payout",
  args: { method: v.string(), handle: v.optional(v.string()), mailingAddress: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { def, row, onboarding, cleaner } = await stepOf(ctx, "payment");
    inScope(ctx, [def.key, "tax_form"]);
    requireVerified(ctx);
    const method = args.method as PayMethod;
    if (!onboarding.content.payment.methods.includes(method)) throw userError("Choose one of the ways the company pays.");
    let handle: string | undefined;
    let mailingAddress: string | undefined;
    if (method === "zelle") {
      const raw = text(args.handle ?? "", "Your Zelle email or mobile number", 120);
      handle = isEmail(raw) ? raw.toLowerCase() : (sendablePhone(raw) ?? undefined);
      if (!handle) throw userError("Enter the email or mobile number registered with Zelle.");
    } else if (method === "venmo") {
      const raw = text(args.handle ?? "", "Your Venmo username", 40).replace(/^@/, "");
      if (!/^[A-Za-z0-9_-]{5,30}$/.test(raw)) throw userError("Enter your Venmo username, for example @maria-diaz.");
      handle = `@${raw}`;
    } else if (method === "check") {
      mailingAddress = text(args.mailingAddress ?? "", "Mailing address", 300);
    }
    const now = Date.now();
    const current = await payoutOf(ctx, ctx.companyId, cleaner._id);
    if (current && current.method === method && current.handle === handle && current.mailingAddress === mailingAddress) return { status: current.status };
    if (current) await ctx.db.patch(current._id, { status: "replaced" });
    await ctx.db.insert("payoutPreferences", { companyId: ctx.companyId, cleanerId: cleaner._id, method, handle, mailingAddress, status: "recorded", recordedAt: now, recordedBy: by(ctx) });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.payout_preference_recorded", actor: actorOf(ctx), subject: { table: "cleaners", id: cleaner._id }, data: { method } });
    await markForReview(ctx, row, { evidence: { text: `Prefers ${PAY_METHOD_WORDS[method].label}.` } }, { label: "Pay preference", where: `They chose ${PAY_METHOD_WORDS[method].label}. Confirm it in their profile before their first payment.` });
    return { status: "recorded" as const };
  },
});

async function taxStep(ctx: Portal) {
  const { def, row, cleaner } = await stepOf(ctx, "tax");
  inScope(ctx, [def.key, "payment_setup"]);
  requireVerified(ctx);
  const plan = taxPlan(ctx.company, cleaner);
  if (plan.form !== "w9") throw userError("Your tax documents are handled outside this page. The office will tell you if anything is needed.");
  if (!(await taxKeyConfigured())) throw userError("Secure tax details are not set up for this company yet. The office will contact you; nothing is needed from you now.");
  return { def, row, cleaner };
}

/** The details for their W-9. The number is sealed before it is stored, and only its last four digits come back. */
export const saveTaxInfo = portalMutation({
  action: "submit_tax",
  args: { legalName: v.string(), businessName: v.optional(v.string()), tinType: v.union(v.literal("ssn"), v.literal("ein"), v.literal("itin")), tin: v.string(), line1: v.string(), city: v.string(), state: v.string(), postalCode: v.string() },
  handler: async (ctx, args) => {
    const { row, cleaner } = await taxStep(ctx);
    const existing = await taxDocOf(ctx, ctx.companyId, cleaner._id);
    if (existing && (existing.status === "preparing" || existing.status === "completed")) throw userError("Your tax document is already done. Ask the office if something needs to change.");
    const legalName = text(args.legalName, "Your legal name", 120);
    const digits = cleanTin(args.tinType, args.tin);
    if (!digits) throw userError(`That ${TIN_WORDS[args.tinType]} does not look right. It has 9 digits.`);
    const state = args.state.trim().toUpperCase();
    if (!US_STATES.has(state)) throw userError("Use the two-letter state, for example TX.");
    const postalCode = args.postalCode.trim();
    if (!/^\d{5}(-\d{4})?$/.test(postalCode)) throw userError("Enter a 5-digit ZIP code.");
    const sealed = await sealTin(digits, cleaner._id);
    if (!sealed) throw userError("Secure tax details are not set up for this company yet.");
    const fields = { form: "w9" as const, status: "awaiting_confirmation" as const, legalName, businessName: optionalText(args.businessName, "Business name", 120), tinType: args.tinType, tinSealed: sealed, tinLast4: digits.slice(-4), address: { line1: text(args.line1, "Street address", 160), city: text(args.city, "City", 80), state, postalCode }, certification: undefined, problem: undefined, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("taxDocuments", { companyId: ctx.companyId, cleanerId: cleaner._id, ...fields });
    if (row.status === "not_started" || row.status === "needs_changes") await ctx.db.patch(row._id, { status: "submitted", submittedAt: Date.now(), submittedBy: by(ctx), updatedAt: Date.now() });
    // The event says that details were given, never what they are.
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.tax_details_given", actor: actorOf(ctx), subject: { table: "cleaners", id: cleaner._id } });
    return { tinLast4: digits.slice(-4) };
  },
});

/** Their own certification, by typed name. The document is then made in the background. */
export const certifyTax = portalMutation({
  action: "submit_tax",
  args: { typedName: v.string(), agreed: v.boolean() },
  handler: async (ctx, args) => {
    const { cleaner } = await taxStep(ctx);
    const doc = await taxDocOf(ctx, ctx.companyId, cleaner._id);
    if (!doc || doc.status !== "awaiting_confirmation") throw userError(doc?.status === "preparing" || doc?.status === "completed" ? "Already certified." : "Fill in your details first.");
    if (!args.agreed) throw userError("Tick the box to certify.");
    const typed = text(args.typedName, "Your full name", 120);
    const norm = (value: string) => value.toLowerCase().replace(/[^a-z]/g, "");
    if (norm(typed) !== norm(doc.legalName ?? "")) throw userError("Type your legal name exactly as you entered it above.");
    const now = Date.now();
    await ctx.db.patch(doc._id, { status: "preparing", certification: { typedName: typed, words: W9_CERTIFICATION, at: now, linkId: ctx.link._id }, preparedAt: now, updatedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.tax_certified", actor: actorOf(ctx), subject: { table: "cleaners", id: cleaner._id } });
    await ctx.scheduler.runAfter(0, internal.cleanerOnboarding.prepareTaxDocument, { docId: doc._id });
    return null;
  },
});

export const taxDocumentData = internalQuery({
  args: { docId: v.id("taxDocuments") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.status !== "preparing") return null;
    const company = await ctx.db.get(doc.companyId);
    return company ? { doc, company: company.name, timezone: company.timezone } : null;
  },
});

/** Makes the document from the worker's own answers and certification, and keeps it. Failure is said, never hidden. */
export const prepareTaxDocument = internalAction({
  args: { docId: v.id("taxDocuments") },
  handler: async (ctx, args): Promise<null> => {
    const data = await ctx.runQuery(internal.cleanerOnboarding.taxDocumentData, args);
    if (!data) return null;
    const tin = data.doc.tinSealed ? await unsealTin(data.doc.tinSealed, data.doc.cleanerId) : null;
    if (!tin || !data.doc.certification || !data.doc.address || !data.doc.tinType) {
      await ctx.runMutation(internal.cleanerOnboarding.taxPrepared, { docId: args.docId, problem: tin ? "Details are missing from the form." : "The taxpayer number could not be read with the current TAX_ID_KEY." });
      return null;
    }
    const bytes = markdownToPdf(w9Markdown({ company: data.company, doc: data.doc, tin, timezone: data.timezone }), { title: "Substitute Form W-9", footer: `${data.company} · confidential` });
    const storageId = await ctx.storage.store(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
    await ctx.runMutation(internal.cleanerOnboarding.taxPrepared, { docId: args.docId, storageId, hash: sha256Bytes(bytes) });
    return null;
  },
});

export const taxPrepared = internalMutation({
  args: { docId: v.id("taxDocuments"), storageId: v.optional(v.id("_storage")), hash: v.optional(v.string()), problem: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc || doc.status !== "preparing") {
      if (args.storageId) await ctx.storage.delete(args.storageId);
      return null;
    }
    const now = Date.now();
    const system: Actor = { kind: "system" };
    if (!args.storageId) {
      await ctx.db.patch(doc._id, { status: "failed", problem: (args.problem ?? "The document could not be made.").slice(0, 300), updatedAt: now });
      await recordEvent(ctx, { companyId: doc.companyId, type: "cleaner.tax_document_failed", actor: system, subject: { table: "cleaners", id: doc.cleanerId } });
      return null;
    }
    await ctx.db.patch(doc._id, { status: "completed", documentId: args.storageId, documentHash: args.hash, completedAt: now, problem: undefined, updatedAt: now });
    await recordEvent(ctx, { companyId: doc.companyId, type: "cleaner.tax_document_completed", actor: system, subject: { table: "cleaners", id: doc.cleanerId } });
    // The tax requirement counts once the document exists, certified by the worker.
    const rows = await ctx.db
      .query("workerRequirements")
      .withIndex("by_company_cleaner", (q) => q.eq("companyId", doc.companyId).eq("cleanerId", doc.cleanerId))
      .take(100);
    const company = await ctx.db.get(doc.companyId);
    const cleaner = await ctx.db.get(doc.cleanerId);
    if (!company || !cleaner) return null;
    const { definitions } = await journeyOf(ctx, company, cleaner, now);
    for (const def of definitions.filter((item) => item.kind === "tax")) {
      const row = rows.find((item) => item.key === def.key);
      if (!row || row.status === "accepted" || row.status === "waived") continue;
      await ctx.db.patch(row._id, { status: "accepted", acceptedAt: now, reviewNote: "Certified by the worker; the document was prepared and stored.", updatedAt: now });
      await recordEvent(ctx, { companyId: doc.companyId, type: "cleaner.requirement_accepted", actor: system, subject: { table: "cleaners", id: doc.cleanerId }, data: { key: def.key, via: "tax_document" } });
      await syncHandoffRequirement(ctx, cleaner, def.key, true, system, "Tax document prepared.");
    }
    return null;
  },
});

// ── Step 7: training ─────────────────────────────────────────────────────────────────────────────

async function moduleOf(ctx: Portal, moduleKey: string) {
  const { def, row, onboarding, cleaner } = await stepOf(ctx, "training");
  inScope(ctx, [def.key]);
  const lesson = onboarding.content.training.modules.find((item) => item.key === moduleKey);
  if (!lesson) throw userError("That module is no longer part of the training.");
  const floor = onboarding.reack[def.key] ?? 0;
  let progress = (
    await ctx.db
      .query("trainingProgress")
      .withIndex("by_company_cleaner", (q) => q.eq("companyId", ctx.companyId).eq("cleanerId", cleaner._id).eq("moduleKey", moduleKey))
      .take(1)
  )[0];
  const now = Date.now();
  // Progress from a version the Owner asked to be done again starts over.
  if (progress && progress.version < floor) {
    await ctx.db.patch(progress._id, { version: onboarding.version, startedAt: now, watchedSeconds: 0, sectionsRead: [], completedAt: undefined, completion: undefined, updatedAt: now });
    progress = (await ctx.db.get(progress._id))!;
  }
  if (!progress) {
    const id = await ctx.db.insert("trainingProgress", { companyId: ctx.companyId, cleanerId: cleaner._id, moduleKey, version: onboarding.version, startedAt: now, watchedSeconds: 0, sectionsRead: [], updatedAt: now });
    progress = (await ctx.db.get(id))!;
  }
  return { def, row, onboarding, cleaner, lesson, progress, floor };
}

/** When every required lesson counts, the training step does too (or goes to the office, if the company checks it). */
async function settleTraining(ctx: Portal, parts: Awaited<ReturnType<typeof moduleOf>>) {
  const { def, row, onboarding, cleaner, floor } = parts;
  const required = requiredModules(onboarding.content);
  const done = completedModules(await trainingOf(ctx, ctx.companyId, cleaner._id), floor);
  if (required.length === 0 || !required.every((lesson) => done.has(lesson.key))) return false;
  const fresh = (await ctx.db.get(row._id))!;
  if ((fresh.status === "accepted" || fresh.status === "awaiting_review") && (fresh.acknowledged?.version ?? 0) >= floor) return true;
  const acknowledged = { words: "required training", at: Date.now(), version: onboarding.version, hash: partsOf(onboarding.content).training };
  if (def.officeReview) await markForReview(ctx, fresh, { acknowledged }, { label: "Training", where: "Every required module is complete. Confirm it in their profile." });
  else await markAccepted(ctx, fresh, { acknowledged }, "Every required training module completed by the cleaner.");
  return true;
}

export const startModule = portalMutation({
  action: "take_training",
  args: { moduleKey: v.string() },
  handler: async (ctx, args) => {
    const { progress } = await moduleOf(ctx, args.moduleKey);
    return { completed: progress.completedAt !== undefined };
  },
});

/**
 * Where the video is. It can only move forward as fast as it plays: a jump ahead is not counted as watched.
 * The furthest point watched in order is kept, so leaving and coming back resumes there.
 */
export const videoProgress = portalMutation({
  action: "take_training",
  args: { moduleKey: v.string(), position: v.number(), duration: v.number() },
  handler: async (ctx, args) => {
    const parts = await moduleOf(ctx, args.moduleKey);
    const { lesson, progress } = parts;
    if (lesson.kind !== "video") throw userError("This module is not a video.");
    if (!Number.isFinite(args.position) || !Number.isFinite(args.duration) || args.duration <= 0 || args.duration > 6 * 3600) throw userError("The video could not be read.");
    const now = Date.now();
    const watched = progress.watchedSeconds ?? 0;
    const elapsed = Math.max(0, (now - progress.updatedAt) / 1000);
    // At most double speed since the last report, with a little slack for a slow connection.
    const reachable = watched + elapsed * 2 + 5;
    const next = Math.min(args.duration, Math.max(watched, Math.min(args.position, reachable)));
    await ctx.db.patch(progress._id, { watchedSeconds: next, durationSeconds: args.duration, updatedAt: now });
    if (progress.completedAt === undefined && next >= args.duration - 2 && now - progress.startedAt >= (args.duration * 1000) / 2) {
      await ctx.db.patch(progress._id, { completedAt: now, completion: "video_watched" });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.training_module_completed", actor: actorOf(ctx), subject: { table: "cleaners", id: parts.cleaner._id }, data: { module: lesson.key, how: "video_watched" } });
      return { watchedSeconds: next, completed: true, trainingDone: await settleTraining(ctx, parts) };
    }
    return { watchedSeconds: next, completed: progress.completedAt !== undefined, trainingDone: false };
  },
});

/** One guide section read, in order, with its question answered correctly where it has one. */
export const readSection = portalMutation({
  action: "take_training",
  args: { moduleKey: v.string(), index: v.number(), answer: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const parts = await moduleOf(ctx, args.moduleKey);
    const { lesson, progress } = parts;
    const sections = lesson.sections ?? [];
    if (lesson.kind !== "guide" || !Number.isInteger(args.index) || args.index < 0 || args.index >= sections.length) throw userError("That section is not part of this module.");
    const read = progress.sectionsRead ?? [];
    if (read.includes(args.index)) return { read: read.length, of: sections.length, completed: progress.completedAt !== undefined, trainingDone: false };
    if (args.index !== read.length) throw userError("Read the sections in order.");
    const check = sections[args.index].check;
    if (check && args.answer !== check.answer) throw userError("Not quite. Read the section again and try another answer.");
    const now = Date.now();
    const next = [...read, args.index];
    await ctx.db.patch(progress._id, { sectionsRead: next, updatedAt: now });
    if (next.length === sections.length && progress.completedAt === undefined) {
      await ctx.db.patch(progress._id, { completedAt: now, completion: "guide_read" });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "cleaner.training_module_completed", actor: actorOf(ctx), subject: { table: "cleaners", id: parts.cleaner._id }, data: { module: lesson.key, how: "guide_read" } });
      return { read: next.length, of: sections.length, completed: true, trainingDone: await settleTraining(ctx, parts) };
    }
    return { read: next.length, of: sections.length, completed: false, trainingDone: false };
  },
});

export type TaxDocId = Id<"taxDocuments">;
