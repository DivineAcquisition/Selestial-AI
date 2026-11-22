/**
 * @vitest-environment edge-runtime
 *
 * Gmail as the hiring inbox: connecting it, reading it incrementally, and sending applicant email from
 * it. Every Google call goes to a fake; nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeGoogle } from "../tests/fakeGoogle";
import { refusal } from "../tests/harness";
import { confirmGmail, flush, HOUR, indeedApplication, MONDAY_10AM, recruiterTestEnv, setup, type Setup } from "../tests/recruiterHarness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { senderWithName } from "./lib/email/provider";
import { gmailConnector, rawMessage, sendFromGmail } from "./lib/recruiter/gmail";
import { MailboxAuthError } from "./lib/recruiter/mailbox";
import { seal, unseal } from "./lib/recruiter/secrets";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const ENV = { GOOGLE_CLIENT_ID: "client-id.apps.test", GOOGLE_CLIENT_SECRET: "client-secret-not-real", MAILBOX_TOKEN_KEY: KEY, CONVEX_SITE_URL: "https://deployment.convex.site.test", APP_ORIGIN: "https://app.selestial.test" };

function useEnv() {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
}

describe("sealing a mailbox's authorization", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("round-trips only for the connection it was sealed for, and refuses to seal without a key", async () => {
    vi.stubEnv("MAILBOX_TOKEN_KEY", KEY);
    const sealed = (await seal("refresh-secret-token", "conn-1"))!;
    expect(sealed).not.toContain("refresh-secret-token");
    expect(await unseal(sealed, "conn-1")).toBe("refresh-secret-token");
    expect(await unseal(sealed, "conn-2")).toBeNull();
    vi.stubEnv("MAILBOX_TOKEN_KEY", "");
    expect(await seal("x", "conn-1")).toBeNull();
    expect(await unseal(sealed, "conn-1")).toBeNull();
  });
});

describe("the Selestial sender before a company inbox is connected", () => {
  it("uses noreply on the verified domain under the company's name, and nothing off that domain", () => {
    const from = "Selestial <team@mail.selestial.io>";
    expect(senderWithName(from, "Alpha Cleaning", "noreply@mail.selestial.io")).toBe('"Alpha Cleaning" <noreply@mail.selestial.io>');
    expect(senderWithName(from, "Alpha Cleaning", "noreply@elsewhere.test")).toBe('"Alpha Cleaning" <team@mail.selestial.io>');
    expect(senderWithName(from, '"\r\n', "noreply@mail.selestial.io")).toBe("noreply@mail.selestial.io");
    expect(senderWithName(from, undefined)).toBe(from);
  });
});

describe("the Gmail connector", () => {
  const scope = { address: "hiring@alpha-cleaning.test", after: MONDAY_10AM - HOUR };
  const message = (id: string, at: number, extra: Partial<Parameters<ReturnType<typeof fakeGoogle>["add"]>[0]> = {}) => ({ id, receivedAt: at, from: "Indeed <no-reply@indeed.com>", subject: "New application for House Cleaner", text: "Maria Lopez applied.\nEmail: maria.lopez@example.test", attachments: [], ...extra });

  it("scans from the start date, then reads only what is new through Gmail's history", async () => {
    const google = fakeGoogle();
    google.add(message("old", MONDAY_10AM - 2 * HOUR));
    google.add(message("m1", MONDAY_10AM));
    google.add(message("m2", MONDAY_10AM + 60_000));
    const gmail = gmailConnector({ token: "access-1", fetch: google.fetch });
    const first = await gmail.list(scope, null, 25);
    // Oldest first, nothing before the start date, headers only.
    expect(first.headers.map((row) => row.id)).toEqual(["m1", "m2"]);
    expect(first.headers[0]).toMatchObject({ from: "Indeed <no-reply@indeed.com>", subject: "New application for House Cleaner" });
    expect(google.state.calls.some((call) => call.includes("format=full"))).toBe(false);
    expect(JSON.parse(first.cursor!)).toEqual({ mode: "history", historyId: "103" });

    google.add(message("m3", MONDAY_10AM + 120_000));
    const second = await gmail.list(scope, first.cursor, 25);
    expect(second.headers.map((row) => row.id)).toEqual(["m3"]);
    expect(await gmail.list(scope, second.cursor, 25)).toMatchObject({ headers: [], more: false });

    // History older than Gmail keeps: it scans again, and filing skips what it already has.
    google.state.oldestHistory = 1000;
    const again = await gmail.list(scope, second.cursor, 25);
    expect(again.headers.map((row) => row.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("never hands over the mailbox's own sent mail or drafts, found by the scan or by history", async () => {
    const google = fakeGoogle();
    google.add(message("in-1", MONDAY_10AM));
    google.add(message("sent-1", MONDAY_10AM + 1000, { labels: ["SENT"], from: "Alpha Cleaning <hiring@alpha-cleaning.test>", subject: "Next step for your House Cleaner application" }));
    google.add(message("draft-1", MONDAY_10AM + 2000, { labels: ["DRAFT"], subject: "Application follow-up" }));
    // Archived mail has no INBOX label and is still received mail.
    google.add(message("archived-1", MONDAY_10AM + 3000, { labels: [] }));
    const gmail = gmailConnector({ token: "access-1", fetch: google.fetch });
    const first = await gmail.list(scope, null, 25);
    expect(first.headers.map((row) => row.id)).toEqual(["in-1", "archived-1"]);
    expect(google.state.calls.filter((call) => call.includes("sent-1") || call.includes("draft-1"))).toEqual([]);
    // History lists every message added, sent ones too: Gmail's own SENT and DRAFT labels drop them.
    google.add(message("sent-2", MONDAY_10AM + 4000, { labels: ["SENT"], from: "Alpha Cleaning <hiring@alpha-cleaning.test>", subject: "Re: your application" }));
    google.add(message("in-2", MONDAY_10AM + 5000));
    expect((await gmail.list(scope, first.cursor, 25)).headers.map((row) => row.id)).toEqual(["in-2"]);
  });

  it("walks a historical import oldest first across pages, so an application is filed before the reply to it", async () => {
    const google = fakeGoogle();
    const base = Date.UTC(2026, 0, 5, 12, 0);
    // Added out of order; Gmail lists newest first whatever order they arrived in.
    for (const n of [3, 1, 5, 2, 4, 7, 6]) google.add(message(`h${n}`, base + n * 60_000));
    const window = { address: scope.address, after: base };
    const read = async (gmail: ReturnType<typeof gmailConnector>) => {
      const order: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const listed = await gmail.list(window, cursor, 2);
        order.push(...listed.headers.map((row) => row.id));
        cursor = listed.cursor;
        if (!listed.more) break;
      }
      return { order, cursor };
    };
    const whole = await read(gmailConnector({ token: "access-1", fetch: google.fetch }));
    expect(whole.order).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7"]);
    expect(JSON.parse(whole.cursor!)).toMatchObject({ mode: "history" });
    // A window larger than one chunk of ids is walked chunk by chunk and still misses nothing; each chunk is oldest first.
    const chunked = await read(gmailConnector({ token: "access-1", fetch: google.fetch, scanCap: 3 }));
    expect([...new Set(chunked.order)].sort()).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7"]);
    expect(chunked.order.slice(0, 3)).toEqual(["h5", "h6", "h7"]);
    expect(JSON.parse(chunked.cursor!)).toMatchObject({ mode: "history" });
    // A cursor an older build saved mid-scan (a page token) starts the scan again rather than failing.
    const legacy = await gmailConnector({ token: "access-1", fetch: google.fetch }).list(window, JSON.stringify({ mode: "scan", historyId: "100", pageToken: "2" }), 25);
    expect(legacy.headers.map((row) => row.id)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7"]);
  });

  it("stays inside the label the Owner named", async () => {
    const google = fakeGoogle();
    google.add(message("in", MONDAY_10AM, { labels: ["Label_7"] }));
    google.add(message("out", MONDAY_10AM, { from: "Aunt Rosa <rosa@family.test>", subject: "Dinner" }));
    const gmail = gmailConnector({ token: "access-1", fetch: google.fetch });
    const first = await gmail.list({ ...scope, folder: "Hiring" }, null, 25);
    expect(first.headers.map((row) => row.id)).toEqual(["in"]);
    google.add(message("in2", MONDAY_10AM + 1000, { labels: ["Label_7"] }));
    google.add(message("out2", MONDAY_10AM + 1000));
    expect((await gmail.list({ ...scope, folder: "Hiring" }, first.cursor, 25)).headers.map((row) => row.id)).toEqual(["in2"]);
    await expect(gmail.list({ ...scope, folder: "No such label" }, first.cursor, 25)).rejects.toThrow("label was not found");
  });

  it("reads a body as plain text, opens text attachments only, and lists the rest", async () => {
    const google = fakeGoogle();
    google.add(message("m1", MONDAY_10AM, { attachments: [{ name: "resume.txt", contentType: "text/plain", size: 40, text: "Dana Cole\ndana.cole@example.test" }, { name: "resume.pdf", contentType: "application/pdf", size: 52_000, text: "never read" }] }));
    const read = (await gmailConnector({ token: "access-1", fetch: google.fetch }).fetch(scope, "m1"))!;
    expect(read.text).toBe("Maria Lopez applied.\nEmail: maria.lopez@example.test");
    expect(read.attachments).toEqual([
      { name: "resume.txt", contentType: "text/plain", size: 40, text: "Dana Cole\ndana.cole@example.test" },
      { name: "resume.pdf", contentType: "application/pdf", size: 52_000 },
    ]);
    expect(await gmailConnector({ token: "access-1", fetch: google.fetch }).fetch(scope, "gone")).toBeNull();
  });

  it("an authorization that has ended is an auth failure, not a provider hiccup", async () => {
    const google = fakeGoogle();
    await expect(gmailConnector({ token: "revoked", fetch: google.fetch }).list(scope, null, 25)).rejects.toBeInstanceOf(MailboxAuthError);
  });

  it("builds a message no name or subject can break, and reports Gmail's answers in plain words", async () => {
    const raw = rawMessage({ from: "hiring@alpha-cleaning.test", fromName: 'Alpha "Cleaning"\r\nBcc: x@evil.test', to: "maria.lopez@example.test", replyTo: "hiring@alpha-cleaning.test", subject: "Next step for your Limpieza application — Señora\r\nBcc: y@evil.test", text: "Hello\nThere", messageId: "msg_1" });
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    expect(decoded.split("\r\n\r\n")[0].split("\r\n").filter((line) => /^bcc:/i.test(line))).toEqual([]);
    expect(decoded).toContain('From: "Alpha Cleaning Bcc: x@evil.test" <hiring@alpha-cleaning.test>');
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    // Replies already reach the sending mailbox, so Reply-To is left out when it is the same address.
    expect(decoded).not.toContain("Reply-To");
    expect(decoded.endsWith("Hello\r\nThere")).toBe(true);
    const google = fakeGoogle();
    expect(await sendFromGmail({ token: "access-1", raw, fetch: google.fetch })).toEqual({ ok: true, providerMessageId: "sent-1", delivered: false });
    expect(await sendFromGmail({ token: "revoked", raw, fetch: google.fetch })).toMatchObject({ ok: false, retryable: false, problem: expect.stringContaining("Reconnect") });
  });
});

describe("connecting Gmail and working through it", () => {
  let undo = () => {};
  let google: ReturnType<typeof fakeGoogle>;
  beforeEach(() => {
    undo = recruiterTestEnv();
    useEnv();
    google = fakeGoogle();
    vi.stubGlobal("fetch", google.fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    undo();
  });

  async function connect(s: Setup, args: { folder?: string; canSend?: boolean } = {}) {
    const { url } = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId, processFrom: MONDAY_10AM - HOUR, ...args });
    const state = new URL(url).searchParams.get("state")!;
    const response = await s.t.fetch(`/oauth/google/callback?state=${encodeURIComponent(state)}&code=good-code`, { method: "GET" });
    await flush(s.t);
    // Google's answer leaves the mailbox waiting; the signed-in Owner confirms it in the app.
    const confirmed = await confirmGmail(s, response);
    return { url, state, response, confirmed };
  }

  it("only the Owner starts it, and the Owner is sent to Google asking for read and send", async () => {
    const s = await setup();
    const manager = await s.manager();
    expect(await refusal(manager.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId }))).toBe("Not allowed.");
    const { url } = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId });
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({ client_id: "client-id.apps.test", redirect_uri: "https://deployment.convex.site.test/oauth/google/callback", access_type: "offline", prompt: "consent", login_hint: "owner-a@example.com" });
    expect(target.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email");
    // Only the state's hash is kept.
    const stored = await s.t.run(async (ctx) => ctx.db.query("oauthStates").collect());
    expect(JSON.stringify(stored)).not.toContain(target.searchParams.get("state"));
  });

  it("is refused plainly when the deployment is not set up for it", async () => {
    const s = await setup();
    vi.stubEnv("MAILBOX_TOKEN_KEY", "");
    expect(await refusal(s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId }))).toContain("isn’t available yet");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(await refusal(s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId }))).toBe("Connecting Gmail isn’t available yet. Please try again a little later.");
  });

  it("stores the authorization sealed, uses the state once, and reads the inbox straight away", async () => {
    const s = await setup();
    google.add({ id: "g1", receivedAt: MONDAY_10AM, from: "Indeed <no-reply@indeed.com>", subject: "New application for House Cleaner", text: "Maria Lopez applied to House Cleaner.\nEmail: maria.lopez@example.test", attachments: [] });
    const { state, response } = await connect(s);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(/^https:\/\/app\.selestial\.test\/app\/settings\/recruiting\?mailbox=confirm&pending=[A-Za-z0-9_-]{20,}$/);
    const stored = await s.t.run(async (ctx) => ({ connections: await ctx.db.query("mailboxConnections").collect(), credentials: await ctx.db.query("mailboxCredentials").collect() }));
    const gmail = stored.connections.find((row) => row.provider === "gmail")!;
    expect(gmail).toMatchObject({ address: "hiring@alpha-cleaning.test", status: "connected", canSend: true });
    expect(JSON.stringify(stored)).not.toContain("refresh-secret-token");
    expect(await unseal(stored.credentials[0].sealedRefreshToken, gmail._id)).toBe("refresh-secret-token");
    // The application came in through Gmail.
    expect(await s.applications()).toEqual([expect.objectContaining({ name: "Maria Lopez", stage: "invitation_awaiting_approval" })]);
    // The same state a second time, an unknown one, or one that expired, connects nothing.
    google.state.codes.add("good-code");
    expect((await s.t.fetch(`/oauth/google/callback?state=${state}&code=good-code`, { method: "GET" })).headers.get("Location")).toContain("mailbox=expired");
    expect((await s.t.fetch(`/oauth/google/callback?state=made-up&code=good-code`, { method: "GET" })).headers.get("Location")).toContain("mailbox=expired");
    const late = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId });
    vi.advanceTimersByTime(11 * 60_000);
    expect((await s.t.fetch(`/oauth/google/callback?state=${new URL(late.url).searchParams.get("state")}&code=good-code`, { method: "GET" })).headers.get("Location")).toContain("mailbox=expired");
  });

  it("connects nothing until the signed-in Owner who started it confirms the mailbox's address", async () => {
    const s = await setup();
    google.add({ id: "g1", receivedAt: MONDAY_10AM, from: "Indeed <no-reply@indeed.com>", subject: "New application for House Cleaner", text: "Maria Lopez applied to House Cleaner.\nEmail: maria.lopez@example.test", attachments: [] });
    const { url } = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId, processFrom: MONDAY_10AM - HOUR });
    const response = await s.t.fetch(`/oauth/google/callback?state=${new URL(url).searchParams.get("state")}&code=good-code`, { method: "GET" });
    await flush(s.t);
    const token = new URL(response.headers.get("Location")!).searchParams.get("pending")!;
    // Google answered, and still: no connection, no credential, nothing read, no watch, nothing in the clear.
    const waiting = await s.t.run(async (ctx) => ({ connections: (await ctx.db.query("mailboxConnections").collect()).filter((row) => row.provider === "gmail"), credentials: await ctx.db.query("mailboxCredentials").collect(), states: await ctx.db.query("oauthStates").collect() }));
    expect(waiting.connections).toEqual([]);
    expect(waiting.credentials).toEqual([]);
    expect(await s.applications()).toEqual([]);
    expect(JSON.stringify(waiting.states)).not.toContain("refresh-secret-token");
    expect(JSON.stringify(waiting.states)).not.toContain(token);
    expect(google.state.calls.some((call) => call.includes("/messages"))).toBe(false);
    // The page shows the address being connected, to the member who started it and to nobody else.
    expect(await s.as.query(api.recruiterMailbox.pendingConnect, { companyId: s.companyId, token })).toMatchObject({ address: "hiring@alpha-cleaning.test", purposes: ["Hiring"], canSend: true });
    expect(await s.as.query(api.recruiterMailbox.pendingConnect, { companyId: s.companyId, token: "made-up" })).toBeNull();
    const manager = await s.manager();
    expect(await manager.query(api.recruiterMailbox.pendingConnect, { companyId: s.companyId, token })).toBeNull();
    expect(await refusal(manager.mutation(api.recruiterMailbox.confirmConnect, { companyId: s.companyId, token }))).toBe("Not allowed.");
    // Confirmed: now it is connected, sealed to its connection, and read.
    expect(await s.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: s.companyId, token })).toEqual({ connected: true, address: "hiring@alpha-cleaning.test" });
    await flush(s.t);
    const after = await s.t.run(async (ctx) => ({ connection: (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!, credentials: await ctx.db.query("mailboxCredentials").collect(), states: await ctx.db.query("oauthStates").collect() }));
    expect(after.connection).toMatchObject({ status: "connected", address: "hiring@alpha-cleaning.test" });
    expect(await unseal(after.credentials[0].sealedRefreshToken, after.connection._id)).toBe("refresh-secret-token");
    expect(after.states.every((row) => row.pending === undefined && row.confirmHash === undefined)).toBe(true);
    expect(await s.applications()).toHaveLength(1);
    // The one-time value works once.
    expect(await refusal(s.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: s.companyId, token }))).toContain("isn't waiting any more");
    expect(google.state.revoked).toEqual([]);
  });

  it("an Owner who sends their Google link to someone else gets nothing: the other person's mailbox is never connected", async () => {
    const attacker = await setup();
    const victim = await setup();
    // The attacker starts the sign-in for their own company and gets the victim to open the link and agree at Google.
    const { url } = await attacker.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: attacker.companyId });
    google.state.email = "victim@other-company.test";
    const response = await attacker.t.fetch(`/oauth/google/callback?state=${new URL(url).searchParams.get("state")}&code=good-code`, { method: "GET" });
    // The one-time value went to the victim's browser, not the attacker's. The victim's own account cannot finish it either.
    const token = new URL(response.headers.get("Location")!).searchParams.get("pending")!;
    expect(await victim.as.query(api.recruiterMailbox.pendingConnect, { companyId: victim.companyId, token })).toBeNull();
    expect(await refusal(victim.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: victim.companyId, token }))).toContain("isn't waiting any more");
    expect(await refusal(victim.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: attacker.companyId, token }))).toBeTruthy();
    // Without that value the attacker has nothing to confirm with: the state they hold is spent and is not it.
    const state = new URL(url).searchParams.get("state")!;
    expect(await refusal(attacker.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: attacker.companyId, token: state }))).toContain("isn't waiting any more");
    // Fifteen minutes on, the access is gone and Google's grant is ended. Nothing was ever connected or read.
    vi.advanceTimersByTime(15 * 60_000 + 1000);
    await attacker.t.finishInProgressScheduledFunctions();
    await flush(attacker.t);
    const left = await attacker.t.run(async (ctx) => ({ gmail: (await ctx.db.query("mailboxConnections").collect()).filter((row) => row.provider === "gmail"), credentials: await ctx.db.query("mailboxCredentials").collect(), states: await ctx.db.query("oauthStates").collect() }));
    expect(left.gmail).toEqual([]);
    expect(left.credentials).toEqual([]);
    expect(left.states.every((row) => row.pending === undefined)).toBe(true);
    expect(google.state.revoked).toEqual(["refresh-secret-token"]);
    expect(await refusal(attacker.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: attacker.companyId, token }))).toContain("isn't waiting any more");
    expect(google.state.calls.some((call) => call.includes("/messages"))).toBe(false);
  });

  it("the Owner can say no on the confirmation page, and an Owner demoted meanwhile cannot say yes", async () => {
    const s = await setup();
    const start = async () => {
      google.state.codes.add("good-code");
      const { url } = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId });
      const response = await s.t.fetch(`/oauth/google/callback?state=${new URL(url).searchParams.get("state")}&code=good-code`, { method: "GET" });
      return new URL(response.headers.get("Location")!).searchParams.get("pending")!;
    };
    await s.as.mutation(api.recruiterMailbox.cancelConnect, { companyId: s.companyId, token: await start() });
    await flush(s.t);
    expect(google.state.revoked).toEqual(["refresh-secret-token"]);
    const token = await start();
    await s.t.run(async (ctx) => {
      const owner = (await ctx.db.query("members").collect()).find((m) => m.companyId === s.companyId && m.role === "owner")!;
      await ctx.db.patch(owner._id, { role: "manager" });
    });
    expect(await refusal(s.as.mutation(api.recruiterMailbox.confirmConnect, { companyId: s.companyId, token }))).toBe("Not allowed.");
    expect(await s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).filter((row) => row.provider === "gmail"))).toEqual([]);
  });

  it("an inbox connected from Recruiting settings is a hiring inbox only; one already in use keeps what it was for", async () => {
    const s = await setup();
    await connect(s);
    const gmail = async () => s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!);
    expect((await gmail()).purposes).toEqual(["hiring"]);
    const listed = await s.as.query(api.inboxes.list, { companyId: s.companyId });
    expect(listed.inboxes.find((row) => row.provider === "gmail")).toMatchObject({ legacy: false, agents: ["recruiter"] });
    // An inbox from before purposes existed keeps its meaning when it is reconnected.
    const { _id: legacyId } = await gmail();
    await s.t.run(async (ctx) => ctx.db.patch(legacyId, { purposes: undefined, status: "expired" }));
    google.state.codes.add("good-code");
    await connect(s);
    expect(await gmail()).toMatchObject({ status: "connected" });
    expect((await gmail()).purposes).toBeUndefined();
  });

  it("disconnecting from Recruiting settings is the same disconnect: Google's grant ends, the watch is dropped and the Owner is told", async () => {
    const s = await setup();
    await connect(s);
    const connectionId = (await s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!._id)) as Id<"mailboxConnections">;
    await s.t.run((ctx) => ctx.db.patch(connectionId, { watchExpiresAt: Date.now() + 5 * 86_400_000 }));
    await s.as.mutation(api.recruiter.disconnectMailbox, { companyId: s.companyId, connectionId });
    await flush(s.t);
    const row = await s.t.run((ctx) => ctx.db.get(connectionId));
    expect(row).toMatchObject({ status: "disconnected", canSend: false, grant: "revoked" });
    expect(row?.watchExpiresAt).toBeUndefined();
    expect(row?.disconnectedAt).toBeDefined();
    expect(google.state.revoked).toEqual(["refresh-secret-token"]);
    const notices = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.purpose === "member_notice").map((m) => String(m.notice?.facts?.kind)));
    expect(notices).toContain("inbox_disconnected");
  });

  it("a read still running when the inbox is disconnected cannot bring it back or raise an alarm", async () => {
    const s = await setup();
    await connect(s);
    const connectionId = (await s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!._id)) as Id<"mailboxConnections">;
    await s.as.mutation(api.recruiter.disconnectMailbox, { companyId: s.companyId, connectionId });
    await flush(s.t);
    const before = await s.t.run(async (ctx) => ({ tasks: (await ctx.db.query("tasks").collect()).length, notices: (await ctx.db.query("messages").collect()).filter((m) => m.purpose === "member_notice").length }));
    // What an in-flight run would still call once its page is filed, or once Google refuses its token.
    await s.t.mutation(internal.recruiterInbox.commit, { connectionId, cursor: "{}" });
    await s.t.mutation(internal.recruiterInbox.failed, { connectionId, kind: "auth" });
    await s.t.mutation(internal.recruiterMailbox.sendRefused, { connectionId });
    await s.t.mutation(internal.recruiterGmailWatch.saved, { connectionId, expiresAt: Date.now() + 86_400_000 });
    await flush(s.t);
    const row = await s.t.run((ctx) => ctx.db.get(connectionId));
    expect(row).toMatchObject({ status: "disconnected", failures: 0 });
    expect(row?.problem).toBeUndefined();
    expect(row?.watchExpiresAt).toBeUndefined();
    expect(await s.t.run(async (ctx) => ({ tasks: (await ctx.db.query("tasks").collect()).length, notices: (await ctx.db.query("messages").collect()).filter((m) => m.purpose === "member_notice").length }))).toEqual(before);
  });

  it("an Owner who declined at Google, or a code Google does not recognise, stores nothing", async () => {
    const s = await setup();
    const { url } = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId });
    const state = new URL(url).searchParams.get("state")!;
    expect((await s.t.fetch(`/oauth/google/callback?state=${state}&error=access_denied`, { method: "GET" })).headers.get("Location")).toContain("mailbox=failed");
    const again = await s.as.mutation(api.recruiterMailbox.startGmailConnect, { companyId: s.companyId });
    expect((await s.t.fetch(`/oauth/google/callback?state=${new URL(again.url).searchParams.get("state")}&code=wrong`, { method: "GET" })).headers.get("Location")).toContain("mailbox=failed");
    expect(await s.t.run(async (ctx) => ctx.db.query("mailboxCredentials").collect())).toEqual([]);
  });

  it("sends applicant email from the company's own address once connected, and stops when Google withdraws access", async () => {
    const s = await setup();
    await connect(s);
    await s.receive(indeedApplication());
    await s.approveAll();
    expect(google.state.sent).toHaveLength(1);
    const headers = google.state.sent[0].decoded.split("\r\n\r\n")[0];
    expect(headers).toContain('From: "Alpha Cleaning Hiring Team" <hiring@alpha-cleaning.test>');
    expect(headers).toContain("To: <maria.lopez@example.test>");
    expect(google.state.sent[0].decoded).toMatch(/\/c\/apply\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    const [row] = await s.applications();
    expect(row.stage).toBe("invited");
    const sent = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "application_invitation")!);
    expect(sent).toMatchObject({ provider: "gmail", status: "sent", providerMessageId: "sent-1" });

    // Google withdraws access. The next email is not sent, and the connection says why.
    google.state.refreshRevoked = true;
    await s.receive(indeedApplication({ id: "second", text: "Lee Wong applied to House Cleaner.\nEmail: lee.wong@example.test\nApplication ID: IND-2" }));
    await s.approveAll();
    expect(google.state.sent).toHaveLength(1);
    const overview = await s.as.query(api.recruiter.overview, { companyId: s.companyId });
    expect(overview.inbox.find((row) => row.provider === "gmail")).toMatchObject({ status: "expired", problem: expect.stringContaining("Reconnect") });
  });

  it("without sending allowed, applicant email keeps going through the shared service", async () => {
    const s = await setup();
    await connect(s, { canSend: false });
    await s.receive(indeedApplication());
    await s.approveAll();
    expect(google.state.sent).toEqual([]);
    const sent = await s.t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.purpose === "application_invitation")!);
    expect(sent.provider).toBe("mock-email");
  });

  it("a connection whose authorization ended is reported, read no more, and recovers on reconnecting", async () => {
    const s = await setup();
    await connect(s);
    google.state.refreshRevoked = true;
    const connectionId = (await s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!._id)) as Id<"mailboxConnections">;
    await s.t.action(internal.recruiterInbox.sync, { connectionId });
    const overview = await s.as.query(api.recruiter.overview, { companyId: s.companyId });
    expect(overview.inbox.find((row) => row.provider === "gmail")).toMatchObject({ status: "expired" });
    google.state.refreshRevoked = false;
    google.state.codes.add("good-code");
    await connect(s);
    expect((await s.as.query(api.recruiter.overview, { companyId: s.companyId })).inbox.find((row) => row.provider === "gmail")).toMatchObject({ status: "connected" });
  });

  it("is connected only through Google, and disconnecting removes the sealed authorization", async () => {
    const s = await setup();
    expect(await refusal(s.as.mutation(api.recruiter.connectMailbox, { companyId: s.companyId, provider: "gmail", address: "hiring@alpha-cleaning.test" }))).toContain("signing in to Google");
    await connect(s);
    const connectionId = (await s.t.run(async (ctx) => (await ctx.db.query("mailboxConnections").collect()).find((row) => row.provider === "gmail")!._id)) as Id<"mailboxConnections">;
    expect(await refusal(s.as.mutation(api.recruiter.reconnectMailbox, { companyId: s.companyId, connectionId }))).toContain("Sign in to Google again");
    await s.as.mutation(api.recruiter.disconnectMailbox, { companyId: s.companyId, connectionId });
    const after = await s.t.run(async (ctx) => ({ connection: await ctx.db.get(connectionId), credentials: await ctx.db.query("mailboxCredentials").collect() }));
    expect(after.connection).toMatchObject({ status: "disconnected", canSend: false });
    expect(after.credentials).toEqual([]);
    // Applicant email goes back to the shared service.
    await s.receive(indeedApplication());
    await s.approveAll();
    expect(google.state.sent).toEqual([]);
  });
});
