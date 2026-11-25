/**
 * @vitest-environment edge-runtime
 *
 * Email branding (docs/email/06-branding.md): saving and reopening, defaults from the company, who may
 * read and change it, the sending address, the reply address and its code, the test email through the
 * real outbox, and that a retried email renders exactly as its first attempt did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, person, refusal, start, type T } from "../tests/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { billingClassOf } from "./lib/messagingBilling/classify";
import { mockEmails } from "./lib/messaging/email";
import { mockEmailOutbox } from "./lib/email/provider";
import { brandedLetter } from "./lib/email/templates/company";
import { aliasBase, resolveBranding } from "./lib/email/branding";

const NOW = Date.UTC(2026, 10, 25, 17, 0);
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

const CHOICES = {
  logoSource: "company" as const,
  header: "light" as const,
  layout: "classic" as const,
  logoAlign: "left" as const,
  signature: { include: true, showAddress: true },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.EMAIL_PROVIDER = "mock";
  mockEmails.length = 0;
  mockEmailOutbox.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.EMAIL_PROVIDER;
});

async function owner(t: T, subject = "owner-a", name = "Bay Area Cleaning Pros") {
  return company(t, subject, name);
}

describe("saving and reading", () => {
  it("starts from the company's own details, saves, and reopens with a new revision", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    const first = await as.query(api.emailBranding.get, { companyId });
    expect(first.saved).toBeNull();
    expect(first.revision).toBe(0);
    expect(first.resolved.senderName).toBe("Bay Area Cleaning Pros");
    expect(first.resolved.accent).toBe("#6838EF");
    expect(first.sender).toMatchObject({ local: "bay-area-cleaning-pros", assigned: false, address: "bay-area-cleaning-pros@mail.selestial.test" });

    const { revision } = await as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: { ...CHOICES, senderName: "  Bay Area Pros  ", accent: "#0b5d3b", layout: "banner", signature: { include: true, showAddress: true, name: "The Bay Area team", phone: "(415) 555-0134", website: "bayareapros.example" } } });
    expect(revision).toBe(1);
    const again = await as.query(api.emailBranding.get, { companyId });
    expect(again.revision).toBe(1);
    expect(again.saved).toMatchObject({ senderName: "Bay Area Pros", accent: "#0B5D3B", layout: "banner" });
    expect(again.resolved).toMatchObject({ senderName: "Bay Area Pros", accent: "#0B5D3B", layout: "banner", signature: { name: "The Bay Area team", website: "https://bayareapros.example" } });
    expect(again.sender.assigned).toBe(true);
    expect(again.updated?.by).toBe("owner-a");
  });

  it("refuses a save that started from an older revision, so a stale tab can't overwrite", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    await as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: { ...CHOICES, accent: "#0B5D3B" } });
    expect(await refusal(as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: { ...CHOICES, accent: "#1F3A93" } }))).toMatch(/Someone else saved/);
    expect((await as.query(api.emailBranding.get, { companyId })).saved?.accent).toBe("#0B5D3B");
  });

  it("refuses header injection, Selestial's name, unreadable colours, offers in the closing line and bad links", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    const save = (extra: Record<string, unknown>) => refusal(as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: { ...CHOICES, ...extra } as typeof CHOICES }));
    expect(await save({ senderName: "Bay Area\r\nBcc: victim@example.com" })).toMatch(/one line/);
    expect(await save({ senderName: 'Bay "Area" <x@y.z>' })).toMatch(/can't contain/);
    expect(await save({ senderName: "Selestial Support" })).toMatch(/not Selestial/);
    expect(await save({ accent: "#FFFF66" })).toMatch(/too light/);
    expect(await save({ button: "red" })).toMatch(/colour like/);
    expect(await save({ signature: { include: true, showAddress: true, closing: "20% off your next clean!" } })).toMatch(/offers or promotions/);
    expect(await save({ signature: { include: true, showAddress: true, website: "javascript:alert(1)" } })).toMatch(/website like/);
    expect(await save({ logoSource: "custom" })).toMatch(/Upload a logo/);
  });

  it("is read by anyone in the company and changed only by the Owner", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    const read = await manager.query(api.emailBranding.get, { companyId });
    expect(read.canEdit).toBe(false);
    expect(read.reply.suggestions).toEqual([]);
    expect(await refusal(manager.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: CHOICES }))).toBe("Not allowed.");
    expect(await refusal(manager.mutation(api.emailBranding.requestReply, { companyId, address: "x@example.com" }))).toBe("Not allowed.");
    expect(await refusal(manager.mutation(api.emailBranding.sendTest, { companyId, sample: "invoice", to: "me" }))).toBe("Not allowed.");
  });

  it("never lets one company read or change another's", async () => {
    const t = start();
    const a = await owner(t, "owner-a", "Alpha Cleaning");
    const b = await owner(t, "owner-b", "Beta Cleaning");
    await a.as.mutation(api.emailBranding.save, { companyId: a.companyId, baseRevision: 0, choices: { ...CHOICES, senderName: "Alpha Team" } });
    expect(await refusal(b.as.query(api.emailBranding.get, { companyId: a.companyId }))).toMatch(/Not/);
    expect(await refusal(b.as.mutation(api.emailBranding.save, { companyId: a.companyId, baseRevision: 1, choices: CHOICES }))).toMatch(/Not/);
    expect((await b.as.query(api.emailBranding.get, { companyId: b.companyId })).resolved.senderName).toBe("Beta Cleaning");
  });
});

describe("the sending address", () => {
  it("is unique: a second company with the same name gets the next free one, and reserved names are never given", async () => {
    const t = start();
    const a = await owner(t, "owner-a", "Sparkle Cleaning");
    const b = await owner(t, "owner-b", "Sparkle Cleaning");
    await a.as.mutation(api.emailBranding.save, { companyId: a.companyId, baseRevision: 0, choices: CHOICES });
    await b.as.mutation(api.emailBranding.save, { companyId: b.companyId, baseRevision: 0, choices: CHOICES });
    expect((await a.as.query(api.emailBranding.get, { companyId: a.companyId })).sender.local).toBe("sparkle-cleaning");
    expect((await b.as.query(api.emailBranding.get, { companyId: b.companyId })).sender.local).toBe("sparkle-cleaning-2");
    expect(aliasBase("Support")).toBe("support-team");
    expect(aliasBase("Selestial")).toBe("co-team");
    expect(aliasBase("Café & Maid Co.")).toBe("cafe-and-maid-co");
    expect(aliasBase("X")).toBe("x-mail");
  });

  it("stays the same when the company is renamed", async () => {
    const t = start();
    const { as, companyId } = await owner(t, "owner-a", "Alpha Cleaning");
    await as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: CHOICES });
    await t.run(async (ctx) => ctx.db.patch(companyId, { name: "Omega Cleaning" }));
    const read = await as.query(api.emailBranding.get, { companyId });
    expect(read.sender.local).toBe("alpha-cleaning");
    expect(read.resolved.senderName).toBe("Omega Cleaning");
  });
});

describe("the logo", () => {
  it("accepts only the company's own fresh upload of a safe image type, never another company's file", async () => {
    const t = start();
    const a = await owner(t, "owner-a", "Alpha Cleaning");
    const b = await owner(t, "owner-b", "Beta Cleaning");
    const png = await t.run(async (ctx) => ctx.storage.store(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })));
    const svg = await t.run(async (ctx) => ctx.storage.store(new Blob(["<svg onload=alert(1)>"], { type: "image/svg+xml" })));
    expect(await refusal(a.as.mutation(api.emailBranding.checkLogo, { companyId: a.companyId, storageId: svg }))).toMatch(/PNG, JPEG or WebP/);
    const checked = await a.as.mutation(api.emailBranding.checkLogo, { companyId: a.companyId, storageId: png });
    expect(checked.url).toMatch(/^https?:\/\//);
    await a.as.mutation(api.emailBranding.save, { companyId: a.companyId, baseRevision: 0, choices: { ...CHOICES, logoSource: "custom", logo: png } });
    expect((await a.as.query(api.emailBranding.get, { companyId: a.companyId })).resolved.logoUrl).toBe(checked.url);
    // Beta can't claim Alpha's file, by checking it or by saving it.
    expect(await refusal(b.as.mutation(api.emailBranding.checkLogo, { companyId: b.companyId, storageId: png }))).toMatch(/wasn't found/);
    expect(await refusal(b.as.mutation(api.emailBranding.save, { companyId: b.companyId, baseRevision: 0, choices: { ...CHOICES, logoSource: "custom", logo: png } }))).toMatch(/wasn't found/);
  });
});

describe("the reply address", () => {
  it("uses the Owner's own verified sign-in email at once", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    expect(await as.mutation(api.emailBranding.requestReply, { companyId, address: "Owner-A@Example.com" })).toEqual({ verified: true });
    expect((await as.query(api.emailBranding.get, { companyId })).reply.active).toMatchObject({ address: "owner-a@example.com", how: "sign_in" });
  });

  it("needs the emailed code for any other address, and keeps the current one until it's entered", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    await as.mutation(api.emailBranding.requestReply, { companyId, address: "owner-a@example.com" });
    expect(await as.mutation(api.emailBranding.requestReply, { companyId, address: "office@bayareapros.example" })).toEqual({ verified: false });
    await settle(t);
    const sent = mockEmailOutbox.find((m) => m.to === "office@bayareapros.example");
    expect(sent?.from).toBe('"Selestial" <messages@mail.selestial.test>');
    const code = sent!.text.match(/\b(\d{6})\b/)![1];
    let read = await as.query(api.emailBranding.get, { companyId });
    expect(read.reply.active?.address).toBe("owner-a@example.com");
    expect(read.reply.pending).toMatchObject({ address: "office@bayareapros.example", delivery: "sent" });
    // The code is never stored, only its hash.
    const row = await t.run(async (ctx) => ctx.db.query("emailBranding").first());
    expect(JSON.stringify(row)).not.toContain(code);

    const wrong = code === "000000" ? "111111" : "000000";
    expect(await as.mutation(api.emailBranding.confirmReply, { companyId, code: wrong })).toMatchObject({ ok: false, words: expect.stringMatching(/isn't right/) });
    expect((await as.query(api.emailBranding.get, { companyId })).reply.active?.address).toBe("owner-a@example.com");
    await as.mutation(api.emailBranding.confirmReply, { companyId, code });
    read = await as.query(api.emailBranding.get, { companyId });
    expect(read.reply.active).toMatchObject({ address: "office@bayareapros.example", how: "code" });
    expect(read.reply.pending).toBeNull();
  });

  it("stops after five wrong codes, refuses expired codes and Selestial's own domains", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    expect(await refusal(as.mutation(api.emailBranding.requestReply, { companyId, address: "x@mail.selestial.test" }))).toMatch(/Selestial's own sending domain/);
    await as.mutation(api.emailBranding.requestReply, { companyId, address: "office@bayareapros.example" });
    await settle(t);
    for (let i = 0; i < 5; i += 1) expect((await as.mutation(api.emailBranding.confirmReply, { companyId, code: "999999" })).ok).toBe(false);
    expect(await refusal(as.mutation(api.emailBranding.confirmReply, { companyId, code: "999999" }))).toMatch(/Too many wrong codes/);
    await as.mutation(api.emailBranding.requestReply, { companyId, address: "office@bayareapros.example" });
    await settle(t);
    const code = mockEmailOutbox.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    vi.setSystemTime(NOW + 31 * 60_000);
    expect(await refusal(as.mutation(api.emailBranding.confirmReply, { companyId, code }))).toMatch(/expired/);
  });
});

describe("real email through Selestial", () => {
  async function ready(t: T, subject = "owner-a") {
    const s = await owner(t, subject);
    await s.as.mutation(api.emailBranding.save, { companyId: s.companyId, baseRevision: 0, choices: { ...CHOICES, accent: "#0B5D3B", senderName: "Bay Area Pros" } });
    return s;
  }

  it("a test email goes through the outbox, from the company's own address, in its branding, marked as a test", async () => {
    const t = start();
    const { as, companyId } = await ready(t);
    const { messageId } = await as.mutation(api.emailBranding.sendTest, { companyId, sample: "invoice", to: "me" });
    await settle(t);
    const [mail] = mockEmails;
    expect(mail.to).toBe("owner-a@example.com");
    expect(mail.from).toBe('"Bay Area Pros" <bay-area-cleaning-pros@mail.selestial.test>');
    expect(mail.subject).toMatch(/^\[Test\] Invoice INV-1042/);
    expect(mail.html).toContain("This is a test of your email branding");
    expect(mail.html).toContain("#0B5D3B");
    expect(mail.html).toContain("sent via Selestial");
    expect(mail.text).toMatch(/^TEST EMAIL: sample content only\./);
    const status = await as.query(api.emailBranding.testStatus, { companyId, messageId });
    expect(status).toMatchObject({ key: "delivered", tone: "good" });
    // Billed like any business email: it isn't one of Selestial's included notices.
    expect(billingClassOf("email_branding_test")).toBe("metered");
  });

  it("goes only to the Owner's own verified email or verified reply address, five an hour", async () => {
    const t = start();
    const { as, companyId } = await ready(t);
    expect(await refusal(as.mutation(api.emailBranding.sendTest, { companyId, sample: "invoice", to: "reply" }))).toMatch(/no verified reply address/);
    const unverified = t.withIdentity(person("owner-a", { emailVerified: false }));
    expect(await refusal(unverified.mutation(api.emailBranding.sendTest, { companyId, sample: "invoice", to: "me" }))).toMatch(/isn't verified/);
    for (let i = 0; i < 5; i += 1) await as.mutation(api.emailBranding.sendTest, { companyId, sample: "proposal", to: "me" });
    expect(await refusal(as.mutation(api.emailBranding.sendTest, { companyId, sample: "proposal", to: "me" }))).toMatch(/5 test emails/);
  });

  it("a retried email renders with the branding of its first attempt, even if branding changed in between", async () => {
    const t = start();
    // The mock fails twice for an address starting "flaky", then delivers.
    const s = await owner(t, "flaky-owner");
    await s.as.mutation(api.emailBranding.save, { companyId: s.companyId, baseRevision: 0, choices: { ...CHOICES, accent: "#0B5D3B" } });
    await s.as.mutation(api.emailBranding.sendTest, { companyId: s.companyId, sample: "invoice", to: "me" });
    // Let the first attempt run and fail, then change the branding before the retry.
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    expect(mockEmails.filter((m) => m.to === "flaky-owner@example.com")).toHaveLength(1);
    await s.as.mutation(api.emailBranding.save, { companyId: s.companyId, baseRevision: 1, choices: { ...CHOICES, accent: "#1F3A93", layout: "letter" } });
    await settle(t);
    const attempts = mockEmails.filter((m) => m.to === "flaky-owner@example.com");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts.map((m) => m.html)).size).toBe(1);
    expect(attempts.at(-1)!.html).toContain("#0B5D3B");
    expect(attempts.at(-1)!.html).not.toContain("#1F3A93");
    // A new email uses the new branding.
    mockEmails.length = 0;
    await s.as.mutation(api.emailBranding.sendTest, { companyId: s.companyId, sample: "invoice", to: "me" });
    await settle(t);
    expect(mockEmails.at(-1)!.html).toContain("#1F3A93");
  });

  it("the verified reply address replaces a workflow's generic fallback, never a routing address it chose", async () => {
    const t = start();
    const { as, companyId } = await ready(t);
    await as.mutation(api.emailBranding.requestReply, { companyId, address: "owner-a@example.com" });
    const send = async (replyTo: string | undefined) => {
      const messageId: Id<"messages"> = await t.run(async (ctx) => {
        const id = await ctx.db.insert("messages", { companyId, purpose: "email_branding_test", channel: "email", subject: "x", to: "owner-a@example.com", body: "Hello.", ...(replyTo ? { replyTo } : {}), dedupeKey: `t:${Math.random()}`, status: "queued", attempts: 0, provider: "mock-email", queuedAt: Date.now() });
        await ctx.db.insert("sendIntents", { companyId, messageId: id, channel: "email", address: "owner-a@example.com", at: Date.now(), category: "operational", origin: "manual" });
        return id;
      });
      await t.action(internal.messaging.deliver, { messageId });
      await settle(t);
      return mockEmails.at(-1)!.replyTo;
    };
    expect(await send(undefined)).toBe("owner-a@example.com");
    expect(await send("r-0123456789abcdef0123456789abcdef@reply.selestial.test")).toBe("r-0123456789abcdef0123456789abcdef@reply.selestial.test");
  });
});

describe("the renderer", () => {
  const defaults = { companyName: "Bay Area Cleaning Pros", logoUrl: null, brandColor: null, phone: null, website: null, address: "1 Market St, San Francisco, CA 94105", supportEmail: null };

  it("the preview and a real send render the same email from the same branding", async () => {
    const t = start();
    const { as, companyId } = await owner(t);
    await as.mutation(api.emailBranding.save, { companyId, baseRevision: 0, choices: { ...CHOICES, accent: "#0B5D3B" } });
    const read = await as.query(api.emailBranding.get, { companyId });
    const sample = read.samples.find((s) => s.id === "proposal")!;
    await as.mutation(api.emailBranding.sendTest, { companyId, sample: "proposal", to: "me" });
    await settle(t);
    const preview = brandedLetter({ branding: read.resolved, text: sample.body, reason: "You're getting this because you asked for a test of your email branding in Selestial.", test: true });
    expect(mockEmails.at(-1)!.html).toBe(preview.html);
  });

  it("escapes everything, keeps the footer, and reads with images off and long names", () => {
    const branding = resolveBranding({ ...CHOICES, logoSource: "custom", logoUrl: "https://files.example/logo.png", senderName: "<script>x</script>", signature: { include: true, showAddress: true, name: "<b>Team</b>", closing: "Thanks for <i>trusting</i> us" } }, { ...defaults, companyName: "The Extraordinarily Long Named Residential & Commercial Cleaning Company of Greater San Francisco" });
    const { html, text } = brandedLetter({ branding, text: "Hi <img src=x onerror=alert(1)>\n\nSee https://example.com/a?b=1", reason: "Why you got this." });
    expect(html).not.toMatch(/<script|<b>Team|<i>trusting|<img src=x/);
    expect(html).toContain("&lt;b&gt;Team&lt;/b&gt;");
    expect(html).toContain('alt="The Extraordinarily Long Named Residential &amp; Commercial Cleaning Company of Greater San Francisco"');
    expect(html).toContain("sent via Selestial");
    expect(html).toContain("Why you got this.");
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(text).toContain("1 Market St, San Francisco, CA 94105");
    for (const layout of ["classic", "banner", "letter"] as const) for (const header of ["light", "dark"] as const) {
      const out = brandedLetter({ branding: { ...branding, layout, header, logoUrl: null }, text: "Hello.", reason: "R." });
      expect(out.html).toContain("max-width:600px");
      expect(out.html).toContain("The Extraordinarily Long Named");
    }
  });

  it("an unreadable colour falls back to a readable one rather than reaching an email", () => {
    expect(resolveBranding({ ...CHOICES, accent: "#FFFF00" }, { ...defaults, brandColor: "#EEEEEE" }).accent).toBe("#6838EF");
    expect(resolveBranding({ ...CHOICES }, { ...defaults, brandColor: "#0b5d3b" }).button).toBe("#0B5D3B");
  });
});
