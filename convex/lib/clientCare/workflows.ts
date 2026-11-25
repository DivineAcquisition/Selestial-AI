/**
 * What Client Care does with one request, step by step. Each workflow reads the record, asks only for what
 * is missing or ambiguous, prepares the step the owner of the work carries out, and words the message from
 * the facts it read. Every step is routed by the Owner's authority (steps.ts); nothing here sends or changes
 * anything directly.
 *
 *   appointment   answers from the visit's own record: booked, offered, accepted, in progress, held
 *   preference    one visit, the property, or the client, asked when not said
 *   access        the property's restricted field, the code never repeated back
 *   reschedule    only times capacity offers; the move re-checks them
 *   cancellation  one visit, a pause, or the whole plan, never assumed
 *   complaint     acknowledged, linked to Retention and Quality, no findings or promises
 *   billing       the existing invoice's record and its own link, nothing marked paid
 *   extra, new service, general   prepared for a person or handed to Sales
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { readProfile } from "../compliance/profile";
import { money } from "../dispatch/pay";
import { planMove } from "../dispatch/reschedule";
import { invoiceState, STATE_WORDS } from "../finance/invoiceState";
import { seal, unseal } from "../recruiter/secrets";
import { noteStatedWish } from "../retention/continuity";
import { loadPlan, previewPlanChange } from "../retention/planChanges";
import { checkCapacity } from "../sales/capacity";
import { fileInquiry } from "../sales/intake";
import { businessSettingsOf, checkHours } from "../settings/business";
import { addLocalDays, clock, dayName, startOfLocalDay } from "../time";
import { dayStartOf } from "../booking/capacity";
import { localParts } from "../availability";
import { mayDo, openBookings, PERMIT_WORDS, pickVisit, plansInScope, propertiesInScope, visitLabel, visitState, visitsInScope, type Permit } from "./context";
import { changeRules, timing } from "./policy";
import type { Answer } from "./read";
import { addEntry, CARE, closeRequest, isOpen, moveRequest, nextCheck, resolveRequest, type Request } from "./requests";
import type { Pending, StepPayload } from "./schema";
import { careSettings, CATEGORY_WORDS } from "./settings";
import { prepareStep, routeStep, stepsOf, type NewStep } from "./steps";
import { compose, numbered, placeName, type Voice } from "./words";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
const PAID_CLAIM = /\b(?:i|we)(?:'ve| have)? (?:already )?paid\b|\bpayment (?:went|was sent)\b/i;
const SUPPLIES = /\b(products?|unscented|fragrance|scent|bleach|chemicals?|eco|green|vinegar|supplies)\b/i;
const REFUND = /\b(refund|money back|credit (?:me|my)|discount|compensat\w*)\b/i;

type Ctx = MutationCtx;
type W = { company: Doc<"companies">; request: Request; customer: Doc<"customers">; voice: Voice; now: number; text: string };

async function voiceFor(ctx: Ctx, company: Doc<"companies">, request: Request): Promise<Voice> {
  const profile = await readProfile(ctx, company._id);
  return { tone: careSettings(company).tone, sender: profile.messaging.senderName?.trim() || company.name, clientName: request.authority.name, first: request.updatesSent === 0 };
}

/** One step, prepared and routed. Its key names the request, the version it was prepared on and what it is. */
async function step(ctx: Ctx, w: W, input: Omit<NewStep, "key"> & { key: string }) {
  const prepared = await prepareStep(ctx, w.request, { ...input, key: `${w.request._id}:v${w.request.version}:${input.key}` });
  return routeStep(ctx, w.company, (await ctx.db.get(w.request._id))!, prepared);
}

async function say(ctx: Ctx, w: W, key: string, permission: string, body: string, extra: Partial<StepPayload> = {}, summary?: string) {
  return step(ctx, w, { kind: "reply", key, permission, summary: summary ?? `Reply to ${w.request.authority.name}`, payload: extra, message: { channel: w.request.conversation.channel, body } });
}

/** Asks the client one question and waits for the answer. Only what is missing or ambiguous is asked. */
async function ask(ctx: Ctx, w: W, kind: Pending["kind"], question: string, options: Pending["options"], body: string) {
  const pending: Pending = { kind, question, options, askedAt: w.now, expiresAt: w.now + DAY, reminded: false };
  const request = await moveRequest(ctx, w.request, { status: "in_progress", pending, nextCheckAt: pending.expiresAt, nextAction: `Waiting for ${w.request.authority.name} to answer: ${question}` });
  await addEntry(ctx, request, { kind: "asked", text: question });
  return say(ctx, { ...w, request }, `ask:${kind}:${w.now}`, "care.acknowledge", body, { awaitsClient: true }, `Ask ${w.request.authority.name}: ${question}`);
}

/** Hands the request to a person or another agent, tells the client honestly, and waits. */
async function handOff(ctx: Ctx, w: W, to: NonNullable<StepPayload["handoffTo"]>, why: string, clientWords: string | null, onOwner: boolean) {
  const who = to === "owner" ? "the office" : to.charAt(0).toUpperCase() + to.slice(1);
  let request = await moveRequest(ctx, w.request, { status: onOwner ? "waiting_owner" : "waiting_team", waiting: { on: onOwner ? "owner" : "team", reason: why, who, since: w.now }, blocker: onOwner ? why : undefined, nextAction: onOwner ? why : `Waiting for ${who}.` });
  await step(ctx, { ...w, request }, { kind: "hand_off", key: `handoff:${to}`, permission: "care.hand_off", summary: `${CATEGORY_WORDS[w.request.category]} for ${w.request.authority.name}: ${why}`.slice(0, 300), payload: { handoffTo: to } });
  request = (await ctx.db.get(w.request._id))!;
  if (clientWords) {
    const promise = w.now + careSettings(w.company).updateEveryHours * HOUR;
    request = await moveRequest(ctx, request, { promised: { words: "An update on where the request stands", by: promise, madeAt: w.now }, nextCheckAt: promise });
    await say(ctx, { ...w, request }, `handoff-ack:${to}`, "care.acknowledge", clientWords, {}, `Tell ${w.request.authority.name} the request is with ${who}`);
  }
}

async function notAllowed(ctx: Ctx, w: W, permit: Permit) {
  await addEntry(ctx, w.request, { kind: "found", text: `${w.request.authority.name} is on record as a ${w.request.authority.roles.join(", ") || "contact"} contact, which doesn't let them ${PERMIT_WORDS[permit]}${w.request.authority.propertyIds.length ? " here" : ""}. Nothing was changed or shared.` });
  return handOff(ctx, w, "owner", `${w.request.authority.name} asked to ${PERMIT_WORDS[permit]}, which their contact role doesn't allow. Confirm with the account before anything changes.`, compose(w.voice, "I'm not able to do that from this contact. I've passed it to the office, who'll confirm with the account."), true);
}

/** Works one request forward from what the record says now. Safe to run again: steps are keyed. */
export async function advance(ctx: Ctx, company: Doc<"companies">, requestId: Id<"careRequests">, input: { text?: string; answer?: Answer | null } = {}): Promise<void> {
  let request = (await ctx.db.get(requestId))!;
  if (!isOpen(request) || request.owner.kind !== "care") return;
  // A step already waiting for approval, or a message already on its way, is not prepared again.
  const live = (await stepsOf(ctx, request)).filter((s) => s.status === "awaiting_approval" || s.status === "ready");
  if (live.length && !input.answer && !input.text) return;
  const customer = (await ctx.db.get(request.customerId))!;
  const settings = careSettings(company);
  const w: W = { company, request, customer, voice: await voiceFor(ctx, company, request), now: Date.now(), text: input.text ?? request.summary };
  if (request.pending && input.answer) {
    const handled = await answered(ctx, w, input.answer);
    if (handled) return;
    request = (await ctx.db.get(requestId))!;
    w.request = request;
  }
  if (!settings.requestTypes.includes(request.category)) return handOff(ctx, w, "owner", `Care Setup leaves ${CATEGORY_WORDS[request.category].toLowerCase()} to people.`, compose(w.voice, "Thanks for your message. I've passed it to the team, who'll get back to you."), true);
  if (request.ask.serious) return complaint(ctx, w);
  switch (request.category) {
    case "appointment":
      return appointment(ctx, w);
    case "preference":
      return preference(ctx, w);
    case "access":
      return access(ctx, w);
    case "reschedule":
      return reschedule(ctx, w);
    case "cancellation":
      return cancellation(ctx, w);
    case "complaint":
      return complaint(ctx, w);
    case "billing":
      return billing(ctx, w);
    case "extra":
      return handOff(ctx, w, "owner", `${request.authority.name} asked for an extra: "${request.ask.detail ?? request.summary}". Client Care doesn't change a visit's price yet: check it's a published extra, confirm the price with the client and add it to the visit.`, compose(w.voice, "Thanks! I've asked the team to check that and confirm the price with you before anything changes."), true);
    case "new_service":
      return newService(ctx, w);
    case "general":
      return handOff(ctx, w, "owner", "A message Client Care doesn't have a workflow for.", compose(w.voice, "Thanks for your message. I've passed it to the team, who'll get back to you."), true);
  }
}

// ── Answers to Care's own questions ─────────────────────────────────────────────────────────────

async function answered(ctx: Ctx, w: W, answer: Answer): Promise<boolean> {
  const pending = w.request.pending!;
  const option = answer.choice !== undefined ? pending.options[answer.choice - 1] : pending.options.find((o) => (o.startsAt !== undefined && answer.day && localParts(o.startsAt, w.company.timezone).day === answer.day && (answer.minute === undefined || localParts(o.startsAt, w.company.timezone).minute === answer.minute)) || (answer.scope && o.scope === answer.scope) || (answer.cancel && o.cancel === answer.cancel));
  const done = async (patch: Parameters<typeof moveRequest>[2]) => {
    const request = await moveRequest(ctx, w.request, { ...patch, material: true, clear: ["pending", "waiting"], status: "in_progress" });
    await addEntry(ctx, request, { kind: "received", text: `${w.request.authority.name} answered: ${option?.label ?? "(in their own words)"}` });
    await advance(ctx, w.company, request._id);
    return true;
  };
  if (pending.kind === "confirm") {
    if (answer.yes) return done({ ask: { ...w.request.ask } });
    if (answer.no) {
      await closeRequest(ctx, w.request, `${w.request.authority.name} said no when asked to confirm.`);
      return true;
    }
    return false;
  }
  if (!option) {
    // A day or time named instead of a numbered choice: the request is worked again with it.
    if (pending.kind === "choose_time" && answer.day) return done({ ask: { ...w.request.ask, when: { day: answer.day, weekday: answer.weekday, minute: answer.minute, words: "their answer" } } });
    if (pending.kind === "details" && (answer.day || answer.minute !== undefined)) return done({ ask: { ...w.request.ask, when: { day: answer.day, weekday: answer.weekday, minute: answer.minute, words: "their answer" } } });
    if (pending.kind === "which_change" && answer.cancel) return done({ ask: { ...w.request.ask, cancel: answer.cancel } });
    if (pending.kind === "which_scope" && answer.scope) return done({ ask: { ...w.request.ask, scope: answer.scope } });
    return false;
  }
  if (pending.kind === "which_visit") return done({ jobId: option.jobId, propertyId: option.propertyId, ask: { ...w.request.ask, target: undefined } });
  if (pending.kind === "which_scope") return done({ propertyId: option.propertyId ?? w.request.propertyId, ask: { ...w.request.ask, scope: option.scope } });
  if (pending.kind === "which_change") return done({ ask: { ...w.request.ask, cancel: option.cancel } });
  if (pending.kind === "choose_time" && option.startsAt !== undefined && option.endsAt !== undefined) return done({ ask: { ...w.request.ask, when: { day: localParts(option.startsAt, w.company.timezone).day, minute: localParts(option.startsAt, w.company.timezone).minute, words: option.label } } });
  return false;
}

// ── A. Appointment and service questions ────────────────────────────────────────────────────────

async function appointment(ctx: Ctx, w: W) {
  const { request, company } = w;
  const tz = company.timezone;
  const visits = await visitsInScope(ctx, w.customer, request.authority, w.now);
  const job = request.jobId ? visits.find((v) => v._id === request.jobId) : null;
  const picked = job ? { kind: "one" as const, job } : pickVisit(visits, request.ask.target, tz, request.propertyId);
  const properties = new Map<string, Doc<"properties"> | null>();
  const place = async (j: Doc<"jobs">) => {
    if (!properties.has(j.propertyId)) properties.set(j.propertyId, await ctx.db.get(j.propertyId));
    return properties.get(j.propertyId) ?? null;
  };
  const several = new Set(visits.map((v) => v.propertyId)).size > 1;
  if (picked.kind === "none") {
    const bookings = await openBookings(ctx, w.customer);
    if (bookings.length) {
      const b = bookings[0];
      const words = b.status === "awaiting" ? `Your booking for ${dayName(b.slot.startsAt, tz)} at ${clock(b.slot.startsAt, tz)} is waiting for payment before it's confirmed.` : `Your booking request for ${dayName(b.slot.startsAt, tz)} at ${clock(b.slot.startsAt, tz)} is with the office to confirm. It isn't booked yet.`;
      await moveRequest(ctx, request, { facts: [{ key: "booking", value: b.status, basis: "record", source: { table: "bookings", id: b._id, label: "Booking" }, at: w.now }] });
      return say(ctx, w, "answer", "care.answer_question", compose(w.voice, words), { resolves: "Answered from the booking record." });
    }
    return handOff(ctx, w, "owner", `${request.authority.name} asked about a visit, and none is booked${request.ask.target ? ` on ${request.ask.target.words}` : ""} for the properties they speak for.`, compose(w.voice, `I don't see a visit booked${request.ask.target ? ` for ${request.ask.target.words}` : ""} on our schedule. I've asked the team to check and get back to you.`), false);
  }
  if (picked.kind === "several" && request.ask.question !== "when") {
    const options = await Promise.all(picked.jobs.map(async (j, i) => ({ key: String(i + 1), label: visitLabel(j, await place(j), tz, several), jobId: j._id, propertyId: j.propertyId })));
    return ask(ctx, w, "which_visit", "Which visit do you mean?", options, compose(w.voice, `Which visit do you mean? ${numbered(options)}. Reply with the number.`));
  }
  if (picked.kind === "several") {
    const lines = await Promise.all(picked.jobs.slice(0, 3).map(async (j) => (await visitState(ctx, j, tz)).words.replace(/^Your visit/, `${several ? `At ${placeName(await place(j))}, your visit` : "Your visit"}`)));
    return say(ctx, w, "answer", "care.answer_question", compose(w.voice, ...lines), { resolves: "Answered from the visit records." });
  }
  const target = picked.job;
  const state = await visitState(ctx, target, tz);
  const facts = [{ key: "visit", value: state.state, basis: "record" as const, source: { table: "jobs", id: target._id, label: "The visit" }, at: w.now }];
  await moveRequest(ctx, request, { jobId: target._id, propertyId: target.propertyId, facts });
  let words: string;
  if (request.ask.question === "included") {
    const scope = (target.serviceSnapshot?.name ? `${target.serviceSnapshot.name}: ` : "") + target.scope.replace(/\s+/g, " ").slice(0, 320);
    words = `Here's what's booked for your visit on ${visitLabel(target, await place(target), tz, several)}: ${scope}`;
  } else if (request.ask.question === "who") {
    words = state.crewNames.length ? `${state.crewNames.join(" and ")} ${state.crewNames.length > 1 ? "are" : "is"} confirmed for ${state.arrival}.` : `${state.words} I'll be able to tell you who's coming once a cleaner accepts it.`;
  } else words = `${state.words}${state.late ? ` ${state.late}` : ""}`;
  return say(ctx, { ...w, request: (await ctx.db.get(request._id))! }, "answer", "care.answer_question", compose(w.voice, words), { jobId: target._id, resolves: "Answered from the visit record." });
}

// ── B. Preferences ──────────────────────────────────────────────────────────────────────────────

async function preference(ctx: Ctx, w: W) {
  const { request, company } = w;
  const tz = company.timezone;
  const visits = await visitsInScope(ctx, w.customer, request.authority, w.now);
  const properties = await propertiesInScope(ctx, w.customer, request.authority);
  const scope = request.ask.scope ?? (request.ask.target ? "one_visit" : undefined);
  const detail = request.ask.detail ?? request.summary;
  if (!scope) {
    const next = visits[0];
    const options: Pending["options"] = [
      ...(next ? [{ key: "1", label: `Just the next visit (${visitLabel(next, null, tz, false)})`, scope: "one_visit" as const, propertyId: next.propertyId }] : []),
      { key: String(next ? 2 : 1), label: properties.length > 1 ? "Every visit at this property" : "Every visit from now on", scope: "all_future" as const },
      ...(properties.length > 1 ? [{ key: String(next ? 3 : 2), label: "Every visit at all your properties", scope: "customer" as const }] : []),
    ];
    return ask(ctx, w, "which_scope", "Should this apply to one visit or every visit?", options, compose(w.voice, `Got it. Should that apply ${numbered(options)}? Reply with the number.`));
  }
  if (scope === "one_visit") {
    const job = request.jobId ? visits.find((v) => v._id === request.jobId) : null;
    const picked = job ? { kind: "one" as const, job } : pickVisit(visits, request.ask.target, tz, request.propertyId);
    if (picked.kind === "several") {
      const options = picked.jobs.map((j, i) => ({ key: String(i + 1), label: visitLabel(j, null, tz, false), jobId: j._id, propertyId: j.propertyId }));
      return ask(ctx, w, "which_visit", "Which visit is this for?", options, compose(w.voice, `Which visit is this for? ${numbered(options)}.`));
    }
    if (picked.kind === "none") return handOff(ctx, w, "owner", `${request.authority.name} gave instructions for a visit that isn't on the schedule: "${detail}".`, compose(w.voice, "I don't see that visit on our schedule. I've passed your note to the team to check."), false);
    if (!mayDo(request.authority, "visit_note", picked.job.propertyId)) return notAllowed(ctx, w, "visit_note");
    const fresh = await moveRequest(ctx, request, { jobId: picked.job._id, propertyId: picked.job.propertyId, nextAction: "Record the instructions on the visit." });
    return step(ctx, { ...w, request: fresh }, { kind: "preference", key: "preference", permission: "care.update_preferences", summary: `Add "${detail.slice(0, 120)}" to the visit on ${visitLabel(picked.job, null, tz, false)} only`, payload: { scope, jobId: picked.job._id, text: detail, staleSafe: true, resolves: "Recorded on that visit, and the client was told." }, message: { channel: request.conversation.channel, body: compose(w.voice, `Done: I've added that to your visit on ${visitLabel(picked.job, null, tz, false)} only. Your other visits are unchanged.`) } });
  }
  const property = request.propertyId ? properties.find((p) => p._id === request.propertyId) : properties.length === 1 ? properties[0] : null;
  if (scope !== "customer" && !property) {
    const options = properties.map((p, i) => ({ key: String(i + 1), label: placeName(p), propertyId: p._id, scope }));
    if (!options.length) return handOff(ctx, w, "owner", "No property is on record for this client.", compose(w.voice, "I've passed your note to the team."), true);
    return ask(ctx, w, "which_scope", "Which property is this for?", options, compose(w.voice, `Which property is this for? ${numbered(options)}.`));
  }
  if (!mayDo(request.authority, "standing_note", property?._id ?? null) || (scope === "customer" && request.authority.propertyIds.length > 0)) return notAllowed(ctx, w, "standing_note");
  const supplies = SUPPLIES.test(detail);
  const where = scope === "customer" ? "all your properties" : placeName(property);
  const fresh = await moveRequest(ctx, request, { propertyId: property?._id, nextAction: "Record the standing instructions." });
  await step(ctx, { ...w, request: fresh }, {
    kind: "preference",
    key: "preference",
    permission: "care.update_preferences",
    summary: `Record "${detail.slice(0, 120)}" for every visit at ${where}`,
    payload: { scope, propertyId: property?._id, text: detail, staleSafe: true, ...(supplies ? {} : { resolves: "Recorded as a standing instruction, and the client was told." }) },
    message: { channel: request.conversation.channel, body: compose(w.voice, `Done: I've noted that for every visit at ${where}.${supplies ? " I've also asked the team to confirm they can use the products you asked for, and I'll let you know." : ""}`) },
  });
  // Products are supplies: the team confirms the crew can do it, and the client hears back.
  if (supplies) await handOff(ctx, { ...w, request: (await ctx.db.get(request._id))! }, "dispatch", `Check the crew can follow "${detail.slice(0, 160)}" at ${where} (supplies), and tell Client Care.`, null, false);
}

// ── C. Access instructions ──────────────────────────────────────────────────────────────────────

async function access(ctx: Ctx, w: W) {
  const { request } = w;
  const properties = await propertiesInScope(ctx, w.customer, request.authority);
  const property = request.propertyId ? properties.find((p) => p._id === request.propertyId) : properties.length === 1 ? properties[0] : null;
  if (!property) {
    const options = properties.map((p, i) => ({ key: String(i + 1), label: placeName(p), propertyId: p._id }));
    if (!options.length) return handOff(ctx, w, "owner", "No property is on record for this client.", compose(w.voice, "Thanks. I've passed the new access details to the office."), true);
    return ask(ctx, w, "which_scope", "Which property are the new access details for?", options, compose(w.voice, `Thanks. Which property are these for? ${numbered(options)}.`));
  }
  if (!mayDo(request.authority, "access", property._id)) return notAllowed(ctx, w, "access");
  // The client's own words, sealed to the request. They are read back only to write the restricted field.
  const original = await ctx.db
    .query("careMessages")
    .withIndex("by_company_customer", (q) => q.eq("companyId", request.companyId).eq("customerId", request.customerId))
    .order("desc")
    .take(10);
  const source = original.find((m) => m.requestIds.includes(request._id) && m.sealed);
  const plain = source?.sealed ? await unseal(source.sealed, source._id) : null;
  const sealed = plain ? await seal(plain, request._id) : null;
  const fresh = await moveRequest(ctx, request, { propertyId: property._id });
  if (!sealed) return handOff(ctx, { ...w, request: fresh }, "owner", `New access details for ${placeName(property)} arrived in the conversation. Read them there and enter them on the property: Client Care cannot store them securely here.`, compose(w.voice, "Thanks. I've passed the new access details to the office to update on your property."), true);
  return step(ctx, { ...w, request: fresh }, { kind: "access", key: "access", permission: "care.update_access", summary: `Replace the access instructions for ${placeName(property)} with what ${request.authority.name} sent (shown only on the property)`, payload: { propertyId: property._id, sealed, staleSafe: true, resolves: "Access instructions updated on the property, and the client was told." }, message: { channel: request.conversation.channel, body: compose(w.voice, `Thanks, I've updated the access details for ${placeName(property)}. Only the crew on your visits will see them.`) } });
}

// ── D. Rescheduling ─────────────────────────────────────────────────────────────────────────────

type Slot = { startsAt: number; endsAt: number; label: string; version: string };

/** Times that would work for this visit, from the company's hours and Dispatch's capacity. Not a reservation. */
async function slotsFor(ctx: Ctx, company: Doc<"companies">, job: Doc<"jobs">, day: string | null, minute: number | null, exclude: number[]): Promise<Slot[]> {
  const tz = company.timezone;
  const length = job.endsAt - job.startsAt;
  const settings = businessSettingsOf(company);
  const original = localParts(job.startsAt, tz).minute;
  const days: number[] = [];
  const first = day ? dayStartOf(day, tz) : startOfLocalDay(Date.now() + DAY, tz);
  if (first === null) return [];
  for (let i = 0; i < (day ? 1 : 4); i += 1) days.push(addLocalDays(first, i, tz));
  const out: Slot[] = [];
  for (const start of days) {
    const minutes = [...new Set([minute ?? original, original, 9 * 60, 11 * 60, 13 * 60, 15 * 60])];
    for (const m of minutes) {
      const startsAt = start + m * MINUTE;
      if (startsAt <= Date.now() + HOUR || exclude.includes(startsAt) || startsAt === job.startsAt) continue;
      const move = { startsAt, endsAt: startsAt + length };
      try {
        checkHours(settings, move, tz);
      } catch {
        continue;
      }
      const capacity = await checkCapacity(ctx, company, move, Math.max(1, job.requiredCrew ?? 1));
      if (capacity.state !== "fits" && capacity.state !== "tight") continue;
      if (capacity.calendarBusy) continue;
      const plan = await planMove(ctx, company, job, move);
      if (plan.plan.problems.length) continue;
      out.push({ ...move, label: `${dayName(startsAt, tz)} at ${clock(startsAt, tz)}`, version: plan.plan.version });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

async function reschedule(ctx: Ctx, w: W) {
  const { request, company } = w;
  const tz = company.timezone;
  const visits = await visitsInScope(ctx, w.customer, request.authority, w.now);
  const job = request.jobId ? visits.find((v) => v._id === request.jobId) : null;
  const picked = job ? { kind: "one" as const, job } : pickVisit(visits, request.ask.target, tz, request.propertyId);
  if (picked.kind === "none") return handOff(ctx, w, "owner", `${request.authority.name} asked to move a visit${request.ask.target ? ` on ${request.ask.target.words}` : ""} that isn't on the schedule.`, compose(w.voice, "I don't see that visit on our schedule. I've asked the team to check and get back to you."), false);
  if (picked.kind === "several") {
    const options = picked.jobs.map((j, i) => ({ key: String(i + 1), label: visitLabel(j, null, tz, false), jobId: j._id, propertyId: j.propertyId }));
    return ask(ctx, w, "which_visit", "Which visit should move?", options, compose(w.voice, `Which visit would you like to move? ${numbered(options)}.`));
  }
  const target = picked.job;
  if (!mayDo(request.authority, "change_visit", target.propertyId)) return notAllowed(ctx, w, "change_visit");
  if (target.status !== "scheduled") return say(ctx, w, "started", "care.answer_question", compose(w.voice, "That visit has already started, so it can't be moved now. I've let the team know."), { resolves: "Told the client the visit had started." });
  if (target.migration?.held) return handOff(ctx, w, "owner", "The visit came from the previous system and is still held for review; it can't be moved until it is released.", compose(w.voice, "That visit is still being set up in our new system. I've asked the office to move it for you and confirm."), false);
  const rules = await changeRules(ctx, company, request.customerId, target.propertyId);
  const when = timing(rules, target.startsAt);
  let request2 = await moveRequest(ctx, request, { jobId: target._id, propertyId: target.propertyId, agreementId: rules.agreementId ?? undefined, facts: [{ key: "notice", value: when.words, basis: "policy", ...(rules.agreementId ? { source: { table: "agreements", id: rules.agreementId, label: rules.source ?? "Agreement" } } : {}), at: w.now }] });
  w = { ...w, request: request2 };
  if (!when.ok) return handOff(ctx, w, "owner", `${request.authority.name} asked to move the visit on ${visitLabel(target, null, tz, false)}. ${when.words}`, compose(w.voice, `Your visit on ${visitLabel(target, null, tz, false)} is close, so the office needs to approve a change. I've asked them and I'll let you know.`), true);
  const desired = request.ask.when;
  if (!desired?.day && desired?.weekday === undefined) return ask(ctx, w, "details", "What day and time would work instead?", [], compose(w.voice, `Sure. What day and time would work instead of ${visitLabel(target, null, tz, false)}?`));
  const day = desired.day ?? null;
  const failed = (await stepsOf(ctx, request2)).filter((s) => s.kind === "reschedule" && s.status === "failed").map((s) => s.payload.startsAt ?? 0);
  const slots = await slotsFor(ctx, company, target, day, desired.minute ?? null, failed);
  const exact = desired.minute !== undefined ? slots.find((s) => localParts(s.startsAt, tz).minute === desired.minute && localParts(s.startsAt, tz).day === day) : null;
  if (exact) {
    request2 = await moveRequest(ctx, request2, { clear: ["pending"], nextAction: `Move the visit to ${exact.label}.` });
    return step(ctx, { ...w, request: request2 }, { kind: "reschedule", key: `move:${exact.startsAt}`, permission: "care.reschedule_visit", summary: `Move the visit on ${visitLabel(target, null, tz, false)} to ${exact.label} (price and service unchanged)`, payload: { jobId: target._id, startsAt: exact.startsAt, endsAt: exact.endsAt, moveVersion: exact.version, staleSafe: true, resolves: `Moved to ${exact.label}, and the client was told.` }, message: { channel: request.conversation.channel, body: compose(w.voice, `Done: your visit is moved to ${exact.label}. Same service and price. We're confirming the crew for the new time.`) } });
  }
  if (!slots.length) {
    const more = day ? await slotsFor(ctx, company, target, null, desired.minute ?? null, failed) : [];
    if (!more.length) return handOff(ctx, w, "owner", `${request.authority.name} asked to move the visit on ${visitLabel(target, null, tz, false)}${desired.words ? ` to ${desired.words}` : ""}, and no time in the next few days fits the team's capacity.`, compose(w.voice, "I couldn't find an open time that soon. I've asked the office to find one with you."), true);
    const options = more.map((s, i) => ({ key: String(i + 1), label: s.label, startsAt: s.startsAt, endsAt: s.endsAt, jobId: target._id }));
    return ask(ctx, w, "choose_time", "Which of these times works?", options, compose(w.voice, `${desired.words ? `${desired.words.charAt(0).toUpperCase()}${desired.words.slice(1)} isn't available. ` : ""}These times are open: ${numbered(options)}. Reply with the number.`));
  }
  const options = slots.map((s, i) => ({ key: String(i + 1), label: s.label, startsAt: s.startsAt, endsAt: s.endsAt, jobId: target._id }));
  return ask(ctx, w, "choose_time", "Which of these times works?", options, compose(w.voice, `${failed.length ? "That time was just taken. " : ""}I can move your ${visitLabel(target, null, tz, false)} visit to ${numbered(options)}. Reply with the number.`));
}

// ── E. Skips and cancellations ──────────────────────────────────────────────────────────────────

async function cancellation(ctx: Ctx, w: W) {
  const { request, company } = w;
  const tz = company.timezone;
  const visits = await visitsInScope(ctx, w.customer, request.authority, w.now);
  const plans = await plansInScope(ctx, w.customer, request.authority);
  const kind = request.ask.cancel;
  if (!kind) {
    const next = request.jobId ? visits.find((v) => v._id === request.jobId) : pickVisit(visits, request.ask.target, tz).kind === "one" ? (pickVisit(visits, request.ask.target, tz) as { job: Doc<"jobs"> }).job : visits[0];
    const options: Pending["options"] = [
      ...(next ? [{ key: "1", label: `Just the visit on ${visitLabel(next, null, tz, false)}`, cancel: "skip_visit" as const, jobId: next._id }] : []),
      ...(plans.length ? [{ key: String(next ? 2 : 1), label: "Pause the service for a while", cancel: "pause_plan" as const }, { key: String(next ? 3 : 2), label: "End the service", cancel: "end_plan" as const }] : []),
    ];
    if (options.length <= 1) {
      if (!next) return handOff(ctx, w, "owner", `${request.authority.name} asked to cancel, and no upcoming visit or plan is on record for them.`, compose(w.voice, "I don't see anything booked to cancel. I've asked the team to check."), false);
      return moveRequest(ctx, request, { ask: { ...request.ask, cancel: "skip_visit" }, jobId: next._id, material: true }).then((r) => advance(ctx, company, r._id));
    }
    return ask(ctx, w, "which_change", "What would you like to cancel?", options, compose(w.voice, `Happy to help. Do you mean ${numbered(options)}? Reply with the number.`));
  }
  if (kind === "skip_visit" || kind === "cancel_visit") {
    const job = request.jobId ? visits.find((v) => v._id === request.jobId) : null;
    const picked = job ? { kind: "one" as const, job } : pickVisit(visits, request.ask.target, tz, request.propertyId);
    if (picked.kind === "none") return handOff(ctx, w, "owner", `${request.authority.name} asked to cancel a visit${request.ask.target ? ` on ${request.ask.target.words}` : ""} that isn't on the schedule.`, compose(w.voice, "I don't see that visit on our schedule. I've asked the team to check."), false);
    if (picked.kind === "several") {
      const options = picked.jobs.map((j, i) => ({ key: String(i + 1), label: visitLabel(j, null, tz, false), jobId: j._id, propertyId: j.propertyId }));
      return ask(ctx, w, "which_visit", "Which visit should be cancelled?", options, compose(w.voice, `Which visit should I cancel? ${numbered(options)}.`));
    }
    const target = picked.job;
    if (!mayDo(request.authority, "change_visit", target.propertyId)) return notAllowed(ctx, w, "change_visit");
    if (target.status !== "scheduled") return say(ctx, w, "started", "care.answer_question", compose(w.voice, "That visit has already started, so it can't be cancelled now. I've let the team know."), { resolves: "Told the client the visit had started." });
    const rules = await changeRules(ctx, company, request.customerId, target.propertyId);
    const when = timing(rules, target.startsAt);
    const fresh = await moveRequest(ctx, request, { jobId: target._id, propertyId: target.propertyId, facts: [{ key: "notice", value: when.words, basis: "policy", at: w.now }] });
    w = { ...w, request: fresh };
    if (!when.ok) return handOff(ctx, w, "owner", `${request.authority.name} asked to cancel the visit on ${visitLabel(target, null, tz, false)}. ${when.words}`, compose(w.voice, `Your visit on ${visitLabel(target, null, tz, false)} is close, so the office needs to confirm the cancellation. I've asked them and I'll let you know.`), true);
    const label = visitLabel(target, null, tz, false);
    const plan = target.planId ? ({ kind: "service", id: target.planId } as const) : (await planRefOf(ctx, target));
    if (plan) {
      const view = await loadPlan(ctx, company._id, plan);
      const preview = view ? await previewPlanChange(ctx, company, view, { change: "skip_visit", jobId: target._id }) : null;
      if (!view || !preview || preview.blocked) return handOff(ctx, w, "owner", preview?.blocked ?? "The plan for this visit could not be read.", compose(w.voice, "I've passed this to the office to sort out."), true);
      return step(ctx, w, { kind: "skip_visit", key: "skip", permission: "care.skip_visit", summary: `Skip the visit on ${label} only; the rest of the series stays as it is`, payload: { plan, change: "skip_visit", jobId: target._id, shown: preview.shown, staleSafe: true, resolves: "Skipped that one visit, and the client was told. The rest of the plan is unchanged." }, message: { channel: request.conversation.channel, body: compose(w.voice, `Done: I've skipped your visit on ${label}. Your other scheduled visits stay as they are.`) } });
    }
    return step(ctx, w, { kind: "cancel_visit", key: "cancel", permission: "care.skip_visit", summary: `Cancel the one-time visit on ${label}`, payload: { jobId: target._id, staleSafe: true, resolves: "Cancelled the visit, and the client was told." }, message: { channel: request.conversation.channel, body: compose(w.voice, `Done: your visit on ${label} is cancelled.`) } });
  }
  // A pause or the end of the service. Retention hears of it as the client's stated wish; it does not delay it.
  const plan = plans.length === 1 ? plans[0] : request.plan ? plans.find((p) => p.ref.id === request.plan!.id) : null;
  if (!plan) {
    if (!plans.length) return handOff(ctx, w, "owner", `${request.authority.name} asked to ${kind === "end_plan" ? "end" : "pause"} their service, and no recurring plan is on record for them.`, compose(w.voice, "I've passed this to the office, who'll confirm with you."), true);
    const options = await Promise.all(plans.map(async (p, i) => ({ key: String(i + 1), label: `${p.label} at ${placeName(await ctx.db.get(p.propertyId))}`, propertyId: p.propertyId, cancel: kind })));
    return ask(ctx, w, "which_scope", "Which service do you mean?", options, compose(w.voice, `Which service do you mean? ${numbered(options)}.`));
  }
  if (!mayDo(request.authority, "change_plan", plan.propertyId)) return notAllowed(ctx, w, "change_plan");
  await noteStatedWish(ctx, company, w.customer, w.text, w.now, request.conversation.channel === "sms" ? "text" : "email", kind === "end_plan" ? "cancel_request" : "reduce_request");
  const view = await loadPlan(ctx, company._id, plan.ref);
  const tomorrow = localParts(w.now + DAY, tz).day;
  const change = kind === "end_plan" ? ("end_service" as const) : ("pause_service" as const);
  const until = kind === "pause_plan" ? request.ask.when?.day : undefined;
  const preview = view ? await previewPlanChange(ctx, company, view, { change, from: tomorrow, until }) : null;
  if (!view || !preview || preview.blocked) return handOff(ctx, w, "owner", preview?.blocked ?? "The plan could not be read.", compose(w.voice, "I've passed this to the office to sort out."), true);
  const fresh = await moveRequest(ctx, request, { plan: plan.ref, propertyId: plan.propertyId, facts: [{ key: "preview", value: preview.consequences.map((c) => c.text).join(" ").slice(0, 400), basis: "derived", at: w.now }] });
  const consequences = preview.consequences.find((c) => c.topic === "bookings")?.text ?? "";
  const billingWords = preview.consequences.find((c) => c.topic === "billing")?.text ?? "";
  return step(ctx, { ...w, request: fresh }, {
    kind: "plan_change",
    key: change,
    permission: "care.change_plan",
    summary: `${kind === "end_plan" ? "End" : "Pause"} the recurring service at ${placeName(await ctx.db.get(plan.propertyId))} from ${preview.from}${until ? ` until ${until}` : ""}. ${consequences}`,
    payload: { plan: plan.ref, change, from: preview.from ?? tomorrow, until: preview.until ?? undefined, shown: preview.shown, staleSafe: true, resolves: `${kind === "end_plan" ? "Ended" : "Paused"} the service as the client asked, and told them.` },
    message: { channel: request.conversation.channel, body: compose(w.voice, kind === "end_plan" ? `Done: your recurring service ends from ${preview.from}. ${consequences} ${billingWords}` : `Done: your service is paused from ${preview.from}${until ? ` until ${until}` : " until you're ready to restart"}. ${consequences} ${billingWords}`) },
  });
}

async function planRefOf(ctx: Ctx, job: Doc<"jobs">) {
  const row = await ctx.db
    .query("planVisits")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .first();
  return row ? ({ kind: "sales", id: row.planId } as const) : null;
}

// ── F. Complaints ───────────────────────────────────────────────────────────────────────────────

async function complaint(ctx: Ctx, w: W) {
  const { request, company } = w;
  const tz = company.timezone;
  const serious = request.ask.serious ?? null;
  const recent = (
    await ctx.db
      .query("jobs")
      .withIndex("by_company_customer_start", (q) => q.eq("companyId", company._id).eq("customerId", request.customerId).gte("startsAt", w.now - 21 * DAY).lte("startsAt", w.now))
      .take(30)
  ).filter((j) => j.status === "completed" && (request.authority.propertyIds.length === 0 || request.authority.propertyIds.includes(j.propertyId)));
  const job = request.jobId ? recent.find((j) => j._id === request.jobId) ?? null : pickVisit(recent.sort((a, b) => b.startsAt - a.startsAt), request.ask.target, tz).kind === "one" ? (pickVisit(recent, request.ask.target, tz) as { job: Doc<"jobs"> }).job : recent.length === 1 ? recent[0] : null;
  if (!job && recent.length > 1 && !serious && !request.ask.target) {
    const options = recent.slice(0, 4).map((j, i) => ({ key: String(i + 1), label: visitLabel(j, null, tz, false), jobId: j._id, propertyId: j.propertyId }));
    return ask(ctx, w, "which_visit", "Which visit was this?", options, compose(w.voice, `I'm sorry to hear that. Which visit was it? ${numbered(options)}.`));
  }
  const promise = w.now + (serious ? 4 * HOUR : careSettings(company).updateEveryHours * HOUR);
  const fresh = await moveRequest(ctx, request, {
    jobId: job?._id,
    propertyId: job?.propertyId ?? request.propertyId,
    urgency: serious ? "urgent" : request.urgency,
    urgencyReason: serious ?? request.urgencyReason,
    status: "waiting_team",
    waiting: { on: "team", reason: serious ? "The Owner reviews a serious concern." : "Quality is reviewing the visit; Retention prepares any remedy.", who: serious ? "the Owner" : "Quality and Retention", since: w.now },
    promised: { words: "An update on the review", by: promise, madeAt: w.now },
    nextCheckAt: promise,
  });
  if (serious) await ctx.db.insert("careEntries", { companyId: company._id, requestId: request._id, kind: "found", text: "A serious concern (safety, damage, theft, injury or conduct). It goes to the Owner now; Client Care states nothing about fault.", actor: CARE, at: w.now });
  const when = job ? ` after your visit on ${visitLabel(job, null, tz, false)}` : "";
  // Acknowledged without findings, fault, refunds or a re-clean time: Quality and Retention own those.
  const body = serious
    ? compose(w.voice, `I'm very sorry. I've passed this straight to the owner, who will contact you directly.`)
    : compose(w.voice, `I'm sorry it wasn't right${when}. I've passed it to our team to review, and I'll update you by ${clock(promise, tz)} ${localParts(promise, tz).day === localParts(w.now, tz).day ? "today" : dayName(promise, tz)}.`);
  await step(ctx, { ...w, request: fresh }, { kind: "complaint", key: "complaint", permission: "care.complaint_intake", summary: `Acknowledge ${request.authority.name}'s concern and open the recovery case${job ? ` for the visit on ${visitLabel(job, null, tz, false)}` : ""}`, payload: { jobId: job?._id, propertyId: job?.propertyId ?? request.propertyId, text: (request.ask.detail ?? w.text).slice(0, 600), staleSafe: true }, message: { channel: request.conversation.channel, body } });
}

// ── G. Invoices and payments ────────────────────────────────────────────────────────────────────

async function billing(ctx: Ctx, w: W) {
  const { request, company } = w;
  if (!mayDo(request.authority, "billing")) return notAllowed(ctx, w, "billing");
  const invoices = (
    await ctx.db
      .query("invoices")
      .withIndex("by_company_customer", (q) => q.eq("companyId", company._id).eq("customerId", request.customerId))
      .order("desc")
      .take(30)
  ).filter((i) => i.status !== "draft" && i.status !== "void");
  const open = invoices.filter((i) => i.status === "open" && i.totals.balanceCents > 0);
  if (REFUND.test(w.text)) return handOff(ctx, w, "owner", `${request.authority.name} asked about a refund, credit or discount. Only the Owner decides that, in Finance.`, compose(w.voice, "I've passed that to the office: refunds and credits are decided by the owner. They'll get back to you."), true);
  if (PAID_CLAIM.test(w.text)) {
    const latest = open[0] ?? invoices[0];
    const state = latest ? STATE_WORDS[invoiceState(latest, w.now)] : null;
    await handOff(ctx, w, "finance", `${request.authority.name} says they paid${latest ? ` invoice ${latest.number ?? ""}`.trimEnd() : ""}. The record shows: ${state ?? "no invoice"}. Check the payment in Finance; nothing was marked paid.`, null, false);
    return say(ctx, { ...w, request: (await ctx.db.get(request._id))! }, "paid-claim", "care.send_invoice_link", compose(w.voice, latest ? `Thanks for letting us know. Our record for invoice ${latest.number ?? ""} shows it as ${state!.toLowerCase()} right now; a payment can take a little while to show. I've asked the office to check it.` : "Thanks for letting us know. I've asked the office to check it."), { invoiceId: latest?._id }, "Tell the client what the invoice record shows, and that the office is checking the payment");
  }
  if (!open.length) {
    const last = invoices[0];
    return say(ctx, w, "answer", "care.send_invoice_link", compose(w.voice, last ? `You have no open invoices. Your last invoice${last.number ? `, ${last.number},` : ""} for ${money(last.totals.totalCents)} is ${STATE_WORDS[invoiceState(last, w.now)].toLowerCase()}.` : "I don't see any invoices for you yet."), { resolves: "Answered from the invoice record.", ...(last ? { invoiceId: last._id } : {}) });
  }
  const inv = open[open.length - 1];
  const others = open.filter((i) => i._id !== inv._id);
  const deposit = inv.depositCents ? ` Deposit ${money(inv.depositCents)}${inv.totals.paidCents >= inv.depositCents ? " received" : ""}.` : "";
  const due = inv.dueAt ? ` Due ${dayName(inv.dueAt, company.timezone)}.` : "";
  const line = `Invoice ${inv.number ?? ""}: total ${money(inv.totals.totalCents)}, paid ${money(inv.totals.paidCents - inv.totals.refundedCents)}, balance ${money(inv.totals.balanceCents)} (${STATE_WORDS[invoiceState(inv, w.now)].toLowerCase()}).${deposit}${due}`.replace("Invoice :", "Your invoice:");
  const rest = others.length ? ` You also have ${others.length} other open ${others.length === 1 ? "invoice" : "invoices"} (${others.map((o) => `${o.number ?? "unnumbered"} ${money(o.totals.balanceCents)}`).join(", ")}).` : "";
  const fresh = await moveRequest(ctx, request, { invoiceId: inv._id, facts: [{ key: "invoice", value: `${inv.number ?? inv._id}: balance ${money(inv.totals.balanceCents)}`, basis: "record", source: { table: "invoices", id: inv._id, label: "Invoice" }, at: w.now }] });
  return step(ctx, { ...w, request: fresh }, { kind: "invoice_link", key: `invoice:${inv._id}`, permission: "care.send_invoice_link", summary: `Send ${request.authority.name} invoice ${inv.number ?? ""} (balance ${money(inv.totals.balanceCents)}) and its own payment link`, payload: { invoiceId: inv._id, resolves: "Sent the invoice's record and its own payment link." }, message: { channel: request.conversation.channel, body: compose(w.voice, `${line}${rest} You can view and pay it here: {link}`) } });
}

// ── New service: Sales ─────────────────────────────────────────────────────────────────────────

async function newService(ctx: Ctx, w: W) {
  const { request, company, customer } = w;
  const { opportunity } = await fileInquiry(ctx, company, {
    contact: { name: request.authority.name, ...(request.conversation.channel === "sms" ? { phone: request.conversation.address } : { email: request.conversation.address }) },
    customerId: customer._id,
    kind: customer.kind === "home" ? "residential" : customer.kind === "short_term_rental" ? "short_term_rental" : "commercial",
    source: { kind: request.conversation.channel === "sms" ? "sms" : "email" },
    inquiry: (request.ask.detail ?? w.text).slice(0, 1000),
    receivedAt: w.now,
    channel: request.conversation.channel,
    dedupeKey: `care:${request._id}`,
    actor: CARE,
  });
  const fresh = await moveRequest(ctx, request, { opportunityId: opportunity._id, status: "waiting_team", waiting: { on: "team", reason: "Sales prepares the quote and talks to the client about it.", who: "Sales", since: w.now }, nextCheckAt: w.now + careSettings(company).updateEveryHours * HOUR });
  await addEntry(ctx, fresh, { kind: "handoff", text: "Handed to Sales as a new inquiry. Sales owns the quote and its conversation.", source: { table: "salesOpportunities", id: opportunity._id, label: "Sales opportunity" } });
  return say(ctx, { ...w, request: fresh }, "sales-ack", "care.acknowledge", compose(w.voice, "Thanks! I've passed that to our sales team, who'll be in touch about a quote."), {}, "Tell the client Sales will be in touch");
}

// ── Follow-through ──────────────────────────────────────────────────────────────────────────────

/** What Care does when it looks at a request on its own: only for pending work, never to look busy. */
export async function followThrough(ctx: Ctx, company: Doc<"companies">, requestId: Id<"careRequests">): Promise<string> {
  let request = (await ctx.db.get(requestId))!;
  if (!isOpen(request)) return "The request is closed.";
  if (request.owner.kind !== "care") return "A person holds the request.";
  const now = Date.now();
  const settings = careSettings(company);
  const w: W = { company, request, customer: (await ctx.db.get(request.customerId))!, voice: await voiceFor(ctx, company, request), now, text: request.summary };
  // Linked work that finished.
  if (request.retentionCaseId) {
    const row = await ctx.db.get(request.retentionCaseId);
    if (!request.qualityCaseId) {
      const qc = await ctx.db.query("qualityCases").withIndex("by_company_retention", (q) => q.eq("companyId", company._id).eq("retentionCaseId", request.retentionCaseId!)).first();
      if (qc) request = await moveRequest(ctx, request, { qualityCaseId: qc._id });
    }
    if (row?.status === "closed") {
      await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: `The recovery case closed: ${row.outcome?.code.replace(/_/g, " ") ?? "closed"}.`, since: now }, blocker: "The recovery case closed. Check the client knows the outcome, then resolve or close this request.", nextAction: "Resolve or close the request." });
      return "The recovery case closed; a person confirms the client knows.";
    }
  }
  if (request.opportunityId) {
    const opp = await ctx.db.get(request.opportunityId);
    if (opp && opp.stage !== "new") {
      await resolveRequest(ctx, request, "Sales has the conversation with the client about the new service.", [{ table: "salesOpportunities", id: opp._id, label: "Sales opportunity" }]);
      return "Sales took the conversation.";
    }
  }
  const handoffs = (await stepsOf(ctx, request)).filter((s) => s.kind === "hand_off" && s.payload.taskId);
  for (const h of handoffs) {
    const task = await ctx.db.get(h.payload.taskId!);
    if (task && (task.status === "done" || task.status === "cancelled") && request.status !== "waiting_owner") {
      await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: `The team ${task.status === "done" ? "finished" : "set aside"} their part${task.outcome ? `: "${task.outcome.slice(0, 160)}"` : ""}.`, since: now }, blocker: "Tell the client what happened, then resolve the request.", nextAction: "Tell the client the outcome and resolve the request." });
      return "The team finished their part; a person tells the client.";
    }
  }
  if (request.pending && request.pending.expiresAt <= now) {
    if (!request.pending.reminded) {
      request = await moveRequest(ctx, request, { pending: { ...request.pending, reminded: true, expiresAt: now + DAY }, nextCheckAt: now + DAY });
      await say(ctx, { ...w, request }, `remind:${request.pending!.askedAt}`, "care.send_update", compose({ ...w.voice, first: false }, `Just checking in: ${request.pending!.question} ${request.pending!.options.length ? numbered(request.pending!.options) : ""}`), { awaitsClient: true }, `Remind ${request.authority.name} of the open question`);
      return "Reminded the client of the open question once.";
    }
    await moveRequest(ctx, request, { status: "waiting_owner", clear: ["pending"], waiting: { on: "owner", reason: "The client hasn't answered Client Care's question, even after one reminder.", since: now }, blocker: "The client hasn't answered. Call them, or close the request.", nextAction: "Reach the client another way, or close the request." });
    return "The client didn't answer after one reminder; a person has it.";
  }
  if (request.promised && request.promised.by <= now && request.status === "waiting_team") {
    if (request.updatesSent >= 4) {
      await moveRequest(ctx, request, { status: "waiting_owner", waiting: { on: "owner", reason: "The team hasn't finished, and Client Care has already updated the client several times.", since: now }, blocker: "The team's part is taking longer than promised. Decide what to tell the client." });
      return "Taking longer than promised; a person decides what to tell the client.";
    }
    const next = now + settings.updateEveryHours * HOUR;
    const who = request.waiting?.who ?? "the team";
    request = await moveRequest(ctx, request, { promised: { words: "An update on where the request stands", by: next, madeAt: now }, nextCheckAt: next });
    await say(ctx, { ...w, request }, `update:${request.promised!.madeAt}`, "care.send_update", compose({ ...w.voice, first: false }, `A quick update: ${who} is still working on your request. I'll update you again by ${clock(next, company.timezone)} ${dayName(next, company.timezone)}.`), {}, `Promised update to ${request.authority.name}`);
    return "Sent the promised update.";
  }
  // A step that failed or was set aside because the record moved: the request is worked again on what is true now.
  if (request.status === "in_progress" && !request.pending) {
    await advance(ctx, company, request._id);
    return "Worked the request again.";
  }
  const due = nextCheck(request, settings, now);
  await ctx.db.patch(request._id, { nextCheckAt: due });
  return "Nothing due.";
}
