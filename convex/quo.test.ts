/**
 * @vitest-environment edge-runtime
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMember, company, refusal, start, workTextsAllowed, type T } from "../tests/harness";
import { fakeQuo, QUO_NUMBER } from "../tests/fakeQuo";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { checkSend } from "./lib/messaging/policy";
import { queueMessage } from "./lib/messaging/outbox";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const OWNER_PHONE = "+15125559999";
const CLEANER_PHONE = "+15125557777";

type Quo = ReturnType<typeof fakeQuo>;
type As = ReturnType<T["withIdentity"]>;

async function settle(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Connects Quo the way an Owner does: key, numbers, test text, reply, agents, new conversations. */
async function readyQuo(t: T, as: As, companyId: Id<"companies">, quo: Quo) {
  await as.mutation(api.quo.connect, { companyId, apiKey: quo.state.key });
  await settle(t);
  await as.mutation(api.quo.selectNumbers, { companyId, numberIds: [QUO_NUMBER.id] });
  await settle(t);
  await as.mutation(api.quo.sendTest, { companyId, to: OWNER_PHONE, fromNumberId: QUO_NUMBER.id, ownNumber: true });
  await settle(t);
  const reply = quo.incoming(QUO_NUMBER.id, OWNER_PHONE, "Got it");
  const event = await quo.event("message.received", reply);
  expect((await t.fetch(event.path, event.init)).status).toBe(200);
  await settle(t);
  await as.mutation(api.quo.setAgents, { companyId, agents: ["dispatch", "sales"] });
  await as.mutation(api.quo.setUseForNew, { companyId, use: true });
}

async function cleanerWithPhone(t: T, as: As, companyId: Id<"companies">, phone = CLEANER_PHONE) {
  const cleanerId = await as.mutation(api.cleaners.create, { companyId, name: "Rosa", engagement: "contractor", skills: [] });
  await t.run((ctx) => ctx.db.patch(cleanerId, { phone }));
  await workTextsAllowed(as, companyId, cleanerId);
  return cleanerId;
}

async function reminder(t: T, companyId: Id<"companies">, cleanerId: Id<"cleaners">, key: string) {
  return t.run(async (ctx) => queueMessage(ctx, { companyId, purpose: "reminder", cleaner: (await ctx.db.get(cleanerId))!, body: "Reminder: your visit tomorrow at 9am.", dedupeKey: key, actor: { kind: "agent", agent: "dispatch" } }));
}

const message = (t: T, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));

describe("Quo: connecting the company's own phone account", () => {
  let quo: Quo;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("MAILBOX_TOKEN_KEY", KEY);
    vi.stubEnv("CONVEX_SITE_URL", "https://deployment.convex.site.test");
    quo = fakeQuo();
    vi.stubGlobal("fetch", quo.fetcher);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("an accepted key is not ready: numbers, Quo's webhook, registration and a verified reply are, and the key never leaves the server", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    const manager = await addMember(t, as, companyId, "manager-a", "manager");
    expect(await refusal(manager.mutation(api.quo.connect, { companyId, apiKey: quo.state.key }))).toBe("Not allowed.");
    expect(await refusal(as.mutation(api.quo.connect, { companyId, apiKey: "short" }))).toContain("doesn't look like a Quo API key");

    await as.mutation(api.quo.connect, { companyId, apiKey: quo.state.key });
    await settle(t);
    let view = await as.query(api.quo.connection, { companyId });
    expect(view).toMatchObject({ state: "setup_incomplete", keyHint: `…${quo.state.key.slice(-4)}`, registration: { status: "approved" } });
    expect(view.state !== "not_connected" && view.available.map((n) => n.phoneNumber)).toEqual(["+15125550100", "+15125550200"]);
    // The key is sealed at rest and appears in no query.
    expect(JSON.stringify(view)).not.toContain(quo.state.key);
    const sealed = await t.run(async (ctx) => (await ctx.db.query("quoSecrets").collect())[0]);
    expect(sealed.sealedKey).not.toContain(quo.state.key);

    await as.mutation(api.quo.selectNumbers, { companyId, numberIds: [QUO_NUMBER.id] });
    await settle(t);
    // Quo's webhook is created for just the chosen number, pointing at this connection.
    expect(quo.webhooks).toHaveLength(1);
    expect(quo.webhooks[0]).toMatchObject({ resourceIds: [QUO_NUMBER.id] });
    expect(quo.webhooks[0].url).toMatch(/^https:\/\/deployment\.convex\.site\.test\/webhooks\/quo\//);
    view = await as.query(api.quo.connection, { companyId });
    expect(view.state).toBe("setup_incomplete");

    // The test goes only when the Owner asks, to a number they say is theirs.
    await as.mutation(api.quo.sendTest, { companyId, to: OWNER_PHONE, fromNumberId: QUO_NUMBER.id, ownNumber: true });
    await settle(t);
    expect(quo.posts()).toHaveLength(1);
    expect(quo.posts()[0].body).toMatchObject({ from: QUO_NUMBER.id, to: [OWNER_PHONE] });
    expect((await as.query(api.quo.connection, { companyId })).state).toBe("setup_incomplete");
    expect((await as.query(api.quo.connection, { companyId })).readiness.agents[0].words).toBe("Automatic replies stay paused until the reply test is complete.");

    const reply = quo.incoming(QUO_NUMBER.id, OWNER_PHONE, "Got it");
    const event = await quo.event("message.received", reply);
    expect((await t.fetch(event.path, event.init)).status).toBe(200);
    await settle(t);
    expect((await as.query(api.quo.connection, { companyId })).state).toBe("ready");
    await as.mutation(api.quo.setAgents, { companyId, agents: ["dispatch"] });
    view = await as.query(api.quo.connection, { companyId });
    // A new company's Dispatch starts on Propose, so the line says it drafts for approval: it comes from the real permission.
    expect(view.readiness.agents.find((a) => a.agent === "dispatch")!.words).toBe("Dispatch is ready to prepare texts for your approval through +15125550100.");
    expect(view.readiness.agents.find((a) => a.agent === "sales")!.words).toContain("isn't allowed");
  });

  it("an agent's reminder goes through Quo: accepted is not delivered, the delivery event settles it, and repeated or late events change nothing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    const queued = await reminder(t, companyId, cleanerId, "r1");
    await settle(t);
    let row = (await message(t, queued._id))!;
    expect(row).toMatchObject({ status: "sent", provider: "quo" });
    expect(quo.posts().at(-1)!.body).toMatchObject({ from: QUO_NUMBER.id, to: [CLEANER_PHONE], content: "Reminder: your visit tomorrow at 9am." });
    // The conversation is pinned to the Quo number it started on.
    const conversation = await t.run(async (ctx) => (await ctx.db.query("smsConversations").collect()).find((c) => c.address === CLEANER_PHONE)!);
    expect(conversation).toMatchObject({ provider: "quo", sender: QUO_NUMBER.phoneNumber, senderId: QUO_NUMBER.id, owner: { kind: "agents" } });

    const sent = quo.messages.find((m) => m.id === row.providerMessageId)!;
    const delivered = await quo.event("message.delivered", sent);
    expect((await t.fetch(delivered.path, delivered.init)).status).toBe(200);
    expect((await t.fetch(delivered.path, delivered.init)).status).toBe(200);
    row = (await message(t, queued._id))!;
    expect(row.status).toBe("delivered");
    // A failure reported after delivery doesn't undo it.
    const failed = await quo.event("message.failed", sent);
    await t.fetch(failed.path, failed.init);
    expect((await message(t, queued._id))!.status).toBe("delivered");
    // The same workflow request twice is one text.
    await reminder(t, companyId, cleanerId, "r1");
    await settle(t);
    expect(quo.posts()).toHaveLength(2);
  });

  it("when Quo's answer is lost, the text is checked against Quo before anything is sent again: found means sent, absent means not sent and never resent", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    quo.state.send = "timeout_after_accept";
    const first = await reminder(t, companyId, cleanerId, "lost-answer");
    await settle(t);
    const accepted = (await message(t, first._id))!;
    expect(accepted.status).toBe("sent");
    expect(accepted.providerMessageId).toBe(quo.messages.at(-1)!.id);
    expect(quo.posts()).toHaveLength(2);

    quo.state.send = "timeout";
    const second = await reminder(t, companyId, cleanerId, "never-arrived");
    await settle(t);
    expect((await message(t, second._id))!).toMatchObject({ status: "not_sent", problem: expect.stringContaining("no record of this text") });
    // One attempt only: nothing was sent again on its own.
    expect(quo.posts()).toHaveLength(3);
  });

  it("keeps companies apart: an event signed with another company's secret, or about another number, is refused or ignored", async () => {
    const t = start();
    const a = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, a.as, a.companyId, quo);
    const b = await company(t, "owner-b", "Beta Cleaning");
    // Beta can't take a number Alpha already texts from.
    await b.as.mutation(api.quo.connect, { companyId: b.companyId, apiKey: quo.state.key });
    await settle(t);
    expect(await refusal(b.as.mutation(api.quo.selectNumbers, { companyId: b.companyId, numberIds: [QUO_NUMBER.id] }))).toContain("already connected to another company");

    const text = quo.incoming(QUO_NUMBER.id, "+15125554444", "hello");
    const forged = await quo.event("message.received", text, { secretOverride: `whsec_${btoa("someone-elses-signing-key-32byte")}`, eventId: "EVforged" });
    expect((await t.fetch(forged.path, forged.init)).status).toBe(401);
    const otherWorkspace = await quo.event("message.received", text, { orgId: "ORother", eventId: "EVother" });
    await t.fetch(otherWorkspace.path, otherWorkspace.init);
    expect(await t.run(async (ctx) => (await ctx.db.query("smsInbound").collect()).filter((row) => row.body === "hello").length)).toBe(0);
    // A webhook address that names no connection.
    expect((await t.fetch("/webhooks/quo/not-a-real-id", forged.init)).status).toBe(404);
  });

  it("a STOP through Quo suppresses the number and queued texts don't go; a paused agent sends nothing while replies are still received", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    const stop = await quo.event("message.received", quo.incoming(QUO_NUMBER.id, CLEANER_PHONE, "STOP"));
    await t.fetch(stop.path, stop.init);
    await settle(t);
    const blocked = await reminder(t, companyId, cleanerId, "after-stop");
    expect(blocked).toMatchObject({ status: "not_sent", refusal: "suppressed" });

    const other = await cleanerWithPhone(t, as, companyId, "+15125558888");
    await as.mutation(api.companies.setPausedAgents, { companyId, agents: ["dispatch"] });
    expect(await reminder(t, companyId, other, "while-paused")).toMatchObject({ status: "not_sent", refusal: "agent_paused" });
    const hello = await quo.event("message.received", quo.incoming(QUO_NUMBER.id, "+15125558888", "Running 10 min late"));
    expect((await t.fetch(hello.path, hello.init)).status).toBe(200);
    expect(await t.run(async (ctx) => (await ctx.db.query("smsInbound").collect()).some((row) => row.body === "Running 10 min late"))).toBe(true);
    // The cleaner's text reaches a person in Dispatch's queue.
    expect(await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).some((task) => task.key === "inbound.reply:+15125558888" && task.agent === "dispatch"))).toBe(true);
  });

  it("someone answering from the Quo app makes agents step back from that conversation until a person returns it", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    await reminder(t, companyId, cleanerId, "first");
    await settle(t);
    const human = quo.humanSends(QUO_NUMBER.id, CLEANER_PHONE, "I'll call you in 5");
    const event = await quo.event("message.delivered", human);
    await t.fetch(event.path, event.init);
    const conversation = await t.run(async (ctx) => (await ctx.db.query("smsConversations").collect()).find((c) => c.address === CLEANER_PHONE)!);
    expect(conversation.owner).toEqual({ kind: "external" });
    // An agent writing in the conversation waits; a standardized reminder still goes; a person's own text goes.
    const ask = (category: "operational" | "marketing", origin: "agent" | "manual", agent?: "sales") => t.run((ctx) => checkSend(ctx, { companyId, channel: "sms", to: CLEANER_PHONE, category, origin, agent, now: Date.now() }));
    expect(await ask("marketing", "agent", "sales")).toMatchObject({ ok: false, code: "conversation_owned" });
    const code = (answer: Awaited<ReturnType<typeof ask>>) => (answer.ok ? null : answer.code);
    expect(code(await ask("operational", "agent", "sales"))).not.toBe("conversation_owned");
    await as.mutation(api.smsConversations.returnToAgents, { companyId, conversationId: conversation._id });
    expect(code(await ask("marketing", "agent", "sales"))).not.toBe("conversation_owned");
    await as.mutation(api.smsConversations.pauseAgents, { companyId, conversationId: conversation._id, paused: true });
    expect(await ask("marketing", "agent", "sales")).toMatchObject({ ok: false, code: "conversation_owned" });
  });

  it("rate limits are retried, missing credits and a revoked key stop sending and tell the Owner, and nothing moves to another number", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    quo.state.send = 429;
    const limited = await reminder(t, companyId, cleanerId, "rate");
    await t.run(async () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    quo.state.send = "ok";
    await settle(t);
    expect((await message(t, limited._id))!.status).toBe("sent");

    quo.state.send = 402;
    const broke = await reminder(t, companyId, cleanerId, "credits");
    await settle(t);
    expect((await message(t, broke._id))!).toMatchObject({ status: "failed", problem: expect.stringContaining("prepaid credits") });
    expect((await as.query(api.quo.connection, { companyId })).state).toBe("degraded");
    expect(await t.run(async (ctx) => (await ctx.db.query("messages").collect()).some((m) => m.notice?.event === "quo_attention"))).toBe(true);
    // While degraded, a new text waits with the reason rather than going another way.
    expect(await reminder(t, companyId, cleanerId, "while-degraded")).toMatchObject({ status: "not_sent", refusal: "sender_not_ready" });

    quo.state.send = "ok";
    await as.mutation(api.quo.recheck, { companyId });
    await settle(t);
    expect((await as.query(api.quo.connection, { companyId })).state).toBe("ready");
    quo.state.send = 401;
    await reminder(t, companyId, cleanerId, "revoked");
    await settle(t);
    expect((await as.query(api.quo.connection, { companyId })).state).toBe("disconnected");
  });

  it("disconnecting blocks sends, removes Quo's webhook and forgets the key; reconnecting proves the reply route again and replays nothing", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const cleanerId = await cleanerWithPhone(t, as, companyId);
    await reminder(t, companyId, cleanerId, "before-disconnect");
    await settle(t);
    expect(await as.mutation(api.quo.disconnect, { companyId })).toEqual({ affected: ["dispatch", "sales"] });
    await settle(t);
    expect(quo.webhooks).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("quoSecrets").collect()).length)).toBe(0);
    const posts = quo.posts().length;
    expect(await reminder(t, companyId, cleanerId, "after-disconnect")).toMatchObject({ status: "not_sent" });
    // History is kept.
    expect(await t.run(async (ctx) => (await ctx.db.query("smsConversations").collect()).length)).toBeGreaterThan(0);

    await as.mutation(api.quo.connect, { companyId, apiKey: quo.state.key });
    await settle(t);
    const view = await as.query(api.quo.connection, { companyId });
    expect(view.state).toBe("setup_incomplete");
    expect(view.state !== "not_connected" && view.replyVerifiedAt).toBeNull();
    expect(quo.posts()).toHaveLength(posts);
  });

  it("a first text asking about service is Sales'; a text from a number on no record that Sales doesn't take goes to the review queue", async () => {
    const t = start();
    const { as, companyId } = await company(t, "owner-a", "Alpha Cleaning");
    await readyQuo(t, as, companyId, quo);
    const inquiry = await quo.event("message.received", quo.incoming(QUO_NUMBER.id, "+15125552222", "Do you clean offices?"));
    await t.fetch(inquiry.path, inquiry.init);
    expect(await t.run(async (ctx) => (await ctx.db.query("salesMessages").collect()).some((row) => row.body?.includes("offices")))).toBe(true);

    // With text inquiries switched off for Sales, the same kind of text goes to a person.
    await t.run((ctx) => ctx.db.patch(companyId, { sales: { eligibility: { kinds: ["residential"], textInquiries: false, commercialNeedsWalkthrough: true } } }));
    const event = await quo.event("message.received", quo.incoming(QUO_NUMBER.id, "+15125553333", "Do you clean offices?"));
    await t.fetch(event.path, event.init);
    const conversation = await t.run(async (ctx) => (await ctx.db.query("smsConversations").collect()).find((c) => c.address === "+15125553333")!);
    expect(conversation.owner).toEqual({ kind: "review" });
    const list = await as.query(api.smsConversations.list, { companyId });
    expect(list.find((row) => row.address === "+15125553333")).toMatchObject({ owner: "review", provider: "quo", sender: QUO_NUMBER.phoneNumber });
    const thread = await as.query(api.smsConversations.thread, { companyId, conversationId: conversation._id });
    expect(thread!.items.at(-1)).toMatchObject({ direction: "incoming", body: "Do you clean offices?" });
    expect(thread!.openTasks).toHaveLength(1);
  });
});
