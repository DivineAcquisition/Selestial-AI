/**
 * Settings › Email & texting › Email branding (docs/email/06-branding.md): how a company's email looks,
 * who it's from and where replies go when Selestial sends it from the shared sending domain.
 *
 *   get           everything the page shows: the saved branding, the company's defaults, the sending
 *                 address, reply handling, delivery readiness and the email rate. Anyone in the company reads.
 *   save          the Owner saves the branding, checked against the revision they started from
 *   uploadUrl     the Owner uploads a logo; checkLogo registers it to the company and answers with its address
 *   requestReply  the Owner chooses a reply address; a code is emailed to it unless ownership is already known
 *   confirmReply  the Owner enters the code; only then does the new address replace the old one
 *   cancelReply   the Owner drops a replacement that's waiting for its code
 *   clearReply    the Owner stops using a reply address; each workflow's own reply address applies again
 *   sendTest      one test email through the real outbox, to the Owner's own verified address only
 *   testStatus    what became of a test email, as the outbox reports it
 *
 * Editing branding costs no AI credits: nothing here calls a model.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { claimImage } from "./lib/booking/images";
import { companyQuery, ownerMutation } from "./lib/builders";
import { userError } from "./lib/errors";
import { byMember, recordEvent } from "./lib/events";
import { allow } from "./lib/rateLimit";
import { problemsOf, resolveBranding, LAYOUT_WORDS, type SavedBranding } from "./lib/email/branding";
import { brandingChoicesValidator } from "./lib/email/brandingSchema";
import { allSamples, sampleEmail, SAMPLE_IDS, type SampleId } from "./lib/email/brandingSamples";
import { brandingRow, companyDefaults, ensureSenderLocal, freeLocal, genericReplies, savedOf, senderLocal } from "./lib/email/brandingStore";
import { companyAddress, platformSender, sharedSendingDomain, verifiedDomains } from "./lib/email/senders";
import { emailProvider as sharedEmailProvider } from "./lib/email/provider";
import { facts, lead, paragraph, renderEmail, title } from "./lib/email/kit";
import { emailProvider } from "./lib/messaging/email";
import { messageState } from "./lib/messaging/lifecycle";
import { formatUnits } from "./lib/messagingBilling/money";
import { priceOf, rateCardAt } from "./lib/messagingBilling/rates";
import { meteringOn } from "./lib/messagingBilling/ledger";
import { replyDomain } from "./lib/sales/replyAddress";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODE_LIFETIME = 30 * MINUTE;
const MAX_CODE_TRIES = 5;
const EMAIL = /^[^\s@<>"(),;:]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;

/** Which workflows use this branding, and how. Only workflows that exist and email through Selestial. */
const WORKFLOWS = [
  { id: "sales", label: "Sales", detail: "Replies, quotes, proposals, signing requests and booking confirmations." },
  { id: "recruiter", label: "Recruiter", detail: "Application links, interview invitations, offers and decisions to applicants." },
  { id: "retention", label: "Retention", detail: "Feedback requests, case updates and return offers to customers." },
  { id: "quality", label: "Quality", detail: "Requests to cleaners for photos or an account of a visit." },
  { id: "finance", label: "Finance", detail: "Invoices, payment reminders and cleaners' earnings statements." },
  { id: "booking", label: "Booking pages", detail: "Booking confirmations, request receipts and finish-your-booking reminders." },
  { id: "cleaners", label: "Cleaners", detail: "Portal invitations, onboarding reminders and availability checks." },
  { id: "manual", label: "Messages you write", detail: "Email you or your team send a client from Selestial, including visit-change notices." },
] as const;

/** What doesn't use this branding, said plainly. */
const NOT_COVERED = [
  "Email sent from a connected Gmail inbox goes from that inbox, as a plain message in the customer's own thread.",
  "Dispatch offers jobs to cleaners by text, so there's no email to brand.",
  "Card receipts come from your Stripe account, designed by Stripe.",
  "Selestial's own email to your team (sign-in, security, billing and alerts) stays from Selestial.",
] as const;

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

function sendingStatus(): { ready: boolean; mode: "live" | "test" | "off"; words: string } {
  const provider = sharedEmailProvider();
  const domain = sharedSendingDomain();
  const mode = process.env.EMAIL_PROVIDER?.trim().toLowerCase() === "mock" ? "test" : provider ? "live" : "off";
  if (!provider || !domain) return { ready: false, mode, words: "Selestial hasn't finished setting up email delivery on this account yet. You can prepare your branding now; emails wait until delivery is ready." };
  if (mode === "test") return { ready: true, mode, words: "This is a test environment: emails are recorded, not delivered." };
  return { ready: true, mode, words: "Selestial handles the sending setup. There's nothing for you to configure." };
}

async function connectedInboxes(ctx: QueryCtx, companyId: Id<"companies">) {
  const rows = await ctx.db
    .query("mailboxConnections")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(20);
  return rows.filter((r) => r.status !== "disconnected" && r.provider !== "mock");
}

async function memberName(ctx: QueryCtx, id: Id<"members"> | undefined): Promise<string | null> {
  if (!id) return null;
  return (await ctx.db.get(id))?.name ?? null;
}

const mask = (address: string) => {
  const [local, domain] = address.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
};

export const get = companyQuery({
  args: {},
  handler: async (ctx) => {
    const company = ctx.company;
    const row = await brandingRow(ctx, ctx.companyId);
    const defaults = await companyDefaults(ctx, company);
    const saved = await savedOf(ctx, row);
    const assignedLocal = await senderLocal(ctx, ctx.companyId);
    // Until the first save or send assigns it, the address it would get.
    const local = assignedLocal ?? (await freeLocal(ctx, company.name));
    const assigned = assignedLocal !== null;
    const inboxes = await connectedInboxes(ctx, ctx.companyId);
    const active = row?.reply ?? null;
    const readable = active ? inboxes.find((i) => i.address.toLowerCase() === active.address && i.status === "connected") : undefined;
    const generic = [...(await genericReplies(ctx, ctx.companyId))];
    const card = rateCardAt(Date.now());
    const isOwner = ctx.role === "owner";
    const me = ctx.identity.emailVerified === true && ctx.identity.email ? ctx.identity.email.trim().toLowerCase() : null;
    return {
      canEdit: isOwner,
      revision: row?.revision ?? 0,
      saved: row ? { ...row.choices, logoUrl: saved?.logoUrl ?? null } : null,
      defaults,
      resolved: resolveBranding(saved, defaults),
      updated: row?.updatedAt ? { at: row.updatedAt, by: await memberName(ctx, row.updatedBy) } : null,
      sender: { local, address: companyAddress(local), assigned, domain: sharedSendingDomain() },
      sending: sendingStatus(),
      reply: {
        active: active ? { address: active.address, verifiedAt: active.verifiedAt, how: active.how } : null,
        pending: isOwner && row?.pendingReply ? { address: row.pendingReply.address, expiresAt: row.pendingReply.expiresAt, delivery: row.pendingReply.delivery, problem: row.pendingReply.problem ?? null } : null,
        // Without a verified address, each workflow's own reply address is used, as before.
        fallback: generic[0] ?? null,
        agentsCanRead: readable ? { address: readable.address, purposes: readable.purposes ?? ["hiring", "sales", "care"] } : null,
        inboxes: inboxes.map((i) => ({ address: i.address, status: i.status, provider: i.provider })),
        suggestions: isOwner ? [...new Set([...inboxes.filter((i) => i.status === "connected").map((i) => i.address.toLowerCase()), ...generic, ...(me ? [me] : [])])].filter((a) => a !== active?.address).slice(0, 4) : [],
        salesRouting: replyDomain() !== null,
      },
      billing: {
        metered: meteringOn(),
        perEmail: formatUnits(priceOf(card, "email_out", 1).amount),
        rateCard: card.version,
      },
      test: { to: isOwner && me ? { address: me, masked: mask(me) } : null, reply: isOwner && active ? active.address : null },
      samples: allSamples(company.name).map((s) => ({ id: s.id, label: s.label, sentBy: s.sentBy, subject: s.subject, body: s.body, reason: s.reason })),
      layouts: LAYOUT_WORDS,
      workflows: WORKFLOWS,
      notCovered: NOT_COVERED,
    };
  },
});

/** What became of a test email, in the outbox's own words. Only the company's own test emails. */
export const testStatus = companyQuery({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.companyId !== ctx.companyId || message.purpose !== "email_branding_test") return null;
    const state = messageState(message);
    return { key: state.key, label: state.label, tone: state.tone, terminal: state.terminal, problem: message.problem ?? null, to: message.to ? mask(message.to) : null, at: message.queuedAt };
  },
});

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────

type Choices = typeof brandingChoicesValidator.type;

/** Trims the page's values and drops empty ones, so an empty field means "use the company's own". */
function cleanChoices(c: Choices): Choices {
  const t = (value: string | undefined) => {
    const trimmed = value?.replace(/\s+/g, " ").trim();
    return trimmed ? trimmed : undefined;
  };
  const s = c.signature;
  return {
    ...c,
    senderName: t(c.senderName),
    accent: t(c.accent)?.toUpperCase(),
    button: t(c.button)?.toUpperCase(),
    logo: c.logoSource === "custom" ? c.logo : undefined,
    signature: { include: s.include, showAddress: s.showAddress, name: t(s.name), closing: t(s.closing), phone: t(s.phone), website: t(s.website), address: t(s.address), supportEmail: t(s.supportEmail)?.toLowerCase() },
  };
}

const RAW_LIMITS: [string, (c: Choices) => string | undefined, number][] = [
  ["sender name", (c) => c.senderName, 200],
  ["signature", (c) => [c.signature.name, c.signature.closing, c.signature.phone, c.signature.website, c.signature.address, c.signature.supportEmail].join(""), 1200],
];

export const save = ownerMutation({
  args: { baseRevision: v.number(), choices: brandingChoicesValidator },
  handler: async (ctx, args) => {
    for (const [what, read, max] of RAW_LIMITS) if ((read(args.choices) ?? "").length > max) throw userError(`The ${what} is too long.`);
    // Header injection is refused, not silently cleaned: the Owner sees what was wrong.
    if (/[\r\n]/.test(args.choices.senderName ?? "")) throw userError("The sender name must be on one line.");
    const choices = cleanChoices(args.choices);
    const row = await brandingRow(ctx, ctx.companyId);
    const current = row?.revision ?? 0;
    if (args.baseRevision !== current) throw userError("Someone else saved the email branding after you started editing. Your edits are kept; discard them to see the latest version.");
    if (choices.logoSource === "custom") {
      if (!choices.logo) throw userError("Upload a logo, or choose to use your company logo.");
      // The file must be this company's own upload: never another company's image or a private file.
      if (choices.logo !== row?.choices.logo) await claimImage(ctx, choices.logo);
    }
    const saved: SavedBranding = { ...choices, logoUrl: choices.logoSource === "custom" && choices.logo ? await ctx.storage.getUrl(choices.logo) : null };
    const problems = problemsOf(saved);
    if (problems.length) throw userError(problems[0]);
    const now = Date.now();
    // The address is assigned with the first save, so the page shows the one customers will see.
    await ensureSenderLocal(ctx, ctx.company);
    const fields = { choices, revision: current + 1, updatedBy: ctx.member._id, updatedAt: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("emailBranding", { companyId: ctx.companyId, ...fields });
    const changed = row ? (Object.keys(choices) as (keyof Choices)[]).filter((k) => JSON.stringify(choices[k]) !== JSON.stringify(row.choices[k])).join(", ") : "all";
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_branding_changed", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { revision: current + 1, changed: changed || "nothing" } });
    return { revision: current + 1 };
  },
});

export const uploadUrl = ownerMutation({
  args: {},
  handler: async (ctx) => {
    if (!(await allow(ctx, `branding-upload:${ctx.companyId}`, 20, HOUR))) throw userError("Too many uploads in the last hour. Try again later.");
    return ctx.storage.generateUploadUrl();
  },
});

/** Registers an uploaded logo to this company (PNG, JPEG or WebP, under 2 MB) and answers with its public address. */
export const checkLogo = ownerMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await claimImage(ctx, args.storageId);
    return { storageId: args.storageId, url: await ctx.storage.getUrl(args.storageId) };
  },
});

// ── Reply address ───────────────────────────────────────────────────────────────────────────────

async function hashCode(companyId: Id<"companies">, address: string, code: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`email-reply:${companyId}:${address}:${code}`)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function rowFor(ctx: MutationCtx & { companyId: Id<"companies"> }): Promise<Doc<"emailBranding">> {
  const row = await brandingRow(ctx, ctx.companyId);
  if (row) return row;
  const id = await ctx.db.insert("emailBranding", { companyId: ctx.companyId, revision: 0, choices: { logoSource: "company", header: "light", layout: "classic", logoAlign: "left", signature: { include: true, showAddress: true } } });
  return (await ctx.db.get(id))!;
}

/**
 * Chooses where replies go. An address whose ownership is already proven (the Owner's own verified sign-in
 * email, or an inbox the company connected through Google) is used at once. Any other address gets a
 * six-digit code by email, and the current address stays in use until the code is entered.
 */
export const requestReply = ownerMutation({
  args: { address: v.string() },
  handler: async (ctx, args) => {
    const address = args.address.trim().toLowerCase();
    if (!EMAIL.test(address) || address.length > 254) throw userError("Enter an email address like office@yourcompany.com.");
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (verifiedDomains().includes(domain) || domain === replyDomain()) throw userError("That address is on Selestial's own sending domain. Choose an inbox your business reads.");
    const row = await rowFor(ctx);
    if (row.reply?.address === address) throw userError("Replies already go to that address.");
    const now = Date.now();
    const verifiedSignIn = ctx.identity.emailVerified === true && ctx.identity.email?.trim().toLowerCase() === address;
    const inbox = (await connectedInboxes(ctx, ctx.companyId)).find((i) => i.address.toLowerCase() === address && i.status === "connected");
    if (verifiedSignIn || inbox) {
      const how = verifiedSignIn ? ("sign_in" as const) : ("connected_inbox" as const);
      await ctx.db.patch(row._id, { reply: { address, verifiedAt: now, verifiedBy: ctx.member._id, how }, pendingReply: undefined });
      await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_reply_verified", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { how } });
      return { verified: true as const };
    }
    if (!(await allow(ctx, `branding-reply-code:${ctx.companyId}`, 5, HOUR))) throw userError("You've asked for 5 codes in the last hour. Try again later.");
    // The code is made and emailed in one step, away from this request, so it's never written anywhere but its hash.
    await ctx.db.patch(row._id, { pendingReply: { address, codeHash: "", expiresAt: now + CODE_LIFETIME, attempts: 0, requestedBy: ctx.member._id, requestedAt: now, delivery: "queued" } });
    await ctx.scheduler.runAfter(0, internal.emailBranding.sendReplyCode, { companyId: ctx.companyId, requestedAt: now });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_reply_requested", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { domain } });
    return { verified: false as const };
  },
});

export const confirmReply = ownerMutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const row = await brandingRow(ctx, ctx.companyId);
    const pending = row?.pendingReply;
    if (!row || !pending) throw userError("There's no address waiting to be confirmed.");
    if (Date.now() > pending.expiresAt) throw userError("That code has expired. Send a new one.");
    if (pending.attempts >= MAX_CODE_TRIES) throw userError("Too many wrong codes. Send a new one.");
    const code = args.code.replace(/\D/g, "");
    if (!pending.codeHash || code.length !== 6 || (await hashCode(ctx.companyId, pending.address, code)) !== pending.codeHash) {
      // Answered, not thrown: a thrown error would undo the count, and the tries would never run out.
      await ctx.db.patch(row._id, { pendingReply: { ...pending, attempts: pending.attempts + 1 } });
      return { ok: false as const, words: pending.attempts + 1 >= MAX_CODE_TRIES ? "That code isn't right, and that was the last try. Send a new one." : "That code isn't right. Check the latest email and try again." };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { reply: { address: pending.address, verifiedAt: now, verifiedBy: ctx.member._id, how: "code" }, pendingReply: undefined });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_reply_verified", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { how: "code" } });
    return { ok: true as const, address: pending.address };
  },
});

export const cancelReply = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const row = await brandingRow(ctx, ctx.companyId);
    if (row?.pendingReply) await ctx.db.patch(row._id, { pendingReply: undefined });
    return null;
  },
});

export const clearReply = ownerMutation({
  args: {},
  handler: async (ctx) => {
    const row = await brandingRow(ctx, ctx.companyId);
    if (!row?.reply) return null;
    await ctx.db.patch(row._id, { reply: undefined });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_reply_cleared", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: {} });
    return null;
  },
});

/** Arms the waiting request with its code's hash. Answers what the email needs, or null when the request was replaced. */
export const armReplyCode = internalMutation({
  args: { companyId: v.id("companies"), requestedAt: v.number(), codeHash: v.string() },
  handler: async (ctx, args) => {
    const row = await brandingRow(ctx, args.companyId);
    const pending = row?.pendingReply;
    if (!row || !pending || pending.requestedAt !== args.requestedAt || pending.codeHash) return null;
    await ctx.db.patch(row._id, { pendingReply: { ...pending, codeHash: args.codeHash } });
    const company = await ctx.db.get(args.companyId);
    const requester = await ctx.db.get(pending.requestedBy);
    return { address: pending.address, companyName: company?.name ?? "your company", requester: requester?.name ?? "The Owner" };
  },
});

export const settleReplyCode = internalMutation({
  args: { companyId: v.id("companies"), requestedAt: v.number(), ok: v.boolean(), problem: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await brandingRow(ctx, args.companyId);
    const pending = row?.pendingReply;
    if (!row || !pending || pending.requestedAt !== args.requestedAt) return null;
    await ctx.db.patch(row._id, { pendingReply: { ...pending, delivery: args.ok ? "sent" : "failed", ...(args.problem ? { problem: args.problem } : {}) } });
    return null;
  },
});

/**
 * Emails the code to the address being confirmed. It is Selestial's own mail (from Selestial, not the
 * company), it isn't charged, and the code exists only here and in the email.
 */
export const sendReplyCode = internalAction({
  args: { companyId: v.id("companies"), requestedAt: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const digits = new Uint32Array(1);
    crypto.getRandomValues(digits);
    const code = String(digits[0] % 1_000_000).padStart(6, "0");
    const peek: string | null = await ctx.runQuery(internal.emailBranding.pendingAddress, { companyId: args.companyId, requestedAt: args.requestedAt });
    if (!peek) return null;
    const armed: { address: string; companyName: string; requester: string } | null = await ctx.runMutation(internal.emailBranding.armReplyCode, { companyId: args.companyId, requestedAt: args.requestedAt, codeHash: await hashCode(args.companyId, peek, code) });
    if (!armed) return null;
    const provider = sharedEmailProvider();
    const sender = platformSender();
    const settle = (ok: boolean, problem?: string): Promise<null> => ctx.runMutation(internal.emailBranding.settleReplyCode, { companyId: args.companyId, requestedAt: args.requestedAt, ok, ...(problem ? { problem } : {}) });
    if (!provider || !sender.ok) return settle(false, sender.ok ? "Email isn't connected on this account, so the code couldn't be sent." : sender.words);
    const email = renderEmail({
      identity: { kind: "platform" },
      preheader: `Your code is ${code}. It works for 30 minutes.`,
      blocks: [
        title("Confirm this reply address"),
        lead(`${armed.requester} asked for replies to ${armed.companyName}'s customer email to come to this address.`),
        facts([{ label: "Your code", value: code }, { label: "Works for", value: "30 minutes" }]),
        paragraph("Enter the code in Selestial, in Settings › Email & texting › Email branding. If you didn't expect this, you can ignore it: nothing changes unless the code is entered."),
      ],
      footer: { reason: `You're getting this because someone at ${armed.companyName} entered this address as the place their customers' replies should go.` },
    });
    try {
      const result = await provider.send({ to: armed.address, from: sender.from, subject: `Your code to confirm ${armed.address}`, html: email.html, text: email.text, idempotencyKey: `email-reply:${args.companyId}:${args.requestedAt}` });
      return settle(result.ok, result.ok ? undefined : result.problem);
    } catch {
      return settle(false, "The email service could not be reached. Send a new code.");
    }
  },
});

export const pendingAddress = internalQuery({
  args: { companyId: v.id("companies"), requestedAt: v.number() },
  handler: async (ctx, args) => {
    const pending = (await brandingRow(ctx, args.companyId))?.pendingReply;
    return pending && pending.requestedAt === args.requestedAt && !pending.codeHash ? pending.address : null;
  },
});

// ── Test email ──────────────────────────────────────────────────────────────────────────────────

const sampleValidator = v.union(...SAMPLE_IDS.map((id) => v.literal(id)));

/**
 * One test email through the real outbox: the same sending address, branding, policy, billing and
 * delivery reports as a real one, marked as a test, with sample words. It goes only to the Owner's own
 * verified sign-in email or the company's verified reply address, never to a customer or a cleaner, and
 * at most 5 an hour. It's charged like any email Selestial delivers.
 */
export const sendTest = ownerMutation({
  args: { sample: sampleValidator, to: v.union(v.literal("me"), v.literal("reply")) },
  handler: async (ctx, args) => {
    const row = await brandingRow(ctx, ctx.companyId);
    const to = args.to === "me" ? (ctx.identity.emailVerified === true && ctx.identity.email ? ctx.identity.email.trim().toLowerCase() : null) : (row?.reply?.address ?? null);
    if (!to) throw userError(args.to === "me" ? "Your sign-in email isn't verified, so a test can't be sent to it." : "There's no verified reply address to send a test to.");
    if (!sharedSendingDomain() || !emailProvider()) throw userError("Email delivery isn't ready on this account yet, so a test can't be sent. Your branding is saved and will be used once it is.");
    if (!(await allow(ctx, `branding-test:${ctx.companyId}`, 5, HOUR))) throw userError("You've sent 5 test emails in the last hour. Try again later.");
    const sample = sampleEmail(args.sample as SampleId, ctx.company.name);
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      companyId: ctx.companyId,
      purpose: "email_branding_test",
      channel: "email",
      subject: `[Test] ${sample.subject}`,
      to,
      body: sample.body,
      authorId: ctx.member._id,
      draftedBy: "person",
      dedupeKey: `branding-test:${ctx.member._id}:${now}`,
      status: "queued",
      attempts: 0,
      provider: emailProvider()?.name,
      queuedAt: now,
    });
    await ctx.db.insert("sendIntents", { companyId: ctx.companyId, messageId, channel: "email", address: to, at: now, category: "operational", origin: "manual" });
    await recordEvent(ctx, { companyId: ctx.companyId, type: "company.email_branding_test", actor: byMember(ctx), subject: { table: "companies", id: ctx.companyId }, data: { sample: args.sample, messageId } });
    await ctx.scheduler.runAfter(0, internal.messaging.deliver, { messageId });
    return { messageId, to: mask(to) };
  },
});
