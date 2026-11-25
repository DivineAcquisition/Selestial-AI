/**
 * Reading a client's message into what they are asking, by rule. A model may read it instead (model.ts), into
 * the same shape, and its reading is checked against the words before it is used (`checkedReading`).
 *
 * A message is data. Nothing in it can change what Care may do, approve anything, or reach another client's
 * records: it only says which request types it seems to raise, the days and times it names, and the client's
 * own words for a preference or an extra. One message can raise several requests ("move Friday to Monday, and
 * please skip the guest room") and each is read separately.
 *
 * What is never inferred: a whole-plan cancellation from "cancel Friday", a payment from "I paid", a scope
 * for a preference that names none, an arrival time, or who someone is from a first name.
 */
import { localParts } from "../availability";
import { areasIn, seriousReason } from "../retention/cases";
import { addLocalDays, startOfLocalDay } from "../time";
import type { Ask, CancelKind, CareCategory, PreferenceScope } from "./schema";

export type Intent = { category: CareCategory; ask: Ask; words: string };
export type Answer = { choice?: number; yes?: boolean; no?: boolean; day?: string; weekday?: number; minute?: number; scope?: PreferenceScope; cancel?: CancelKind };
export type Reading = {
  intents: Intent[];
  /** Nothing but thanks, an OK or an emoji. */
  ack: boolean;
  /** What the message could be answering, if Care asked something. */
  answer: Answer | null;
  serious: string | null;
  /** The message gives new access details (a code, a key place). Their words are withheld from storage. */
  access: boolean;
  areas: string[];
  reader: string;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const ACK = /^(?:ok(?:ay)?|k|thanks?(?: you)?(?: so much)?|thank u|thx|ty|great|perfect|sounds good|got it|cool|awesome|will do|noted|appreciate it|👍|🙏|❤️|😊|\s)+[.!]*$/i;
const YES = /^(?:yes|yep|yeah|yup|sure|correct|that'?s right|confirm(?:ed)?|please do|go ahead|that works|works for me|do it)\b/i;
const NO = /^(?:no|nope|nah|not really|don'?t|never ?mind|cancel that)\b/i;

const RESCHEDULE = /\b(reschedul\w*|move (?:my|our|the|it|this|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b|move\b.*\bto\b|push (?:it|back|the)|change (?:the )?(?:day|date|time)|different (?:day|time|date)|another (?:day|time)|come (?:on|a) (?:different|another)|instead of|switch (?:it )?to|can (?:you|we) (?:come|do (?:it|that)) (?:on|at)\b.*\binstead)/i;
const SKIP = /\b(skip|don'?t come|no (?:need to come|cleaning)|won'?t need (?:you|cleaning|the cleaning)|not need (?:you|cleaning))\b/i;
const CANCEL_WORD = /\bcancel\w*\b/i;
const PAUSE = /\b(pause|put (?:it |the service |us )?on hold|hold off|take a break|on vacation|away until|until (?:we|i)'?(?:re| am| are)? back)\b/i;
const END_PLAN = /\b(cancel (?:my|our|the) (?:service|plan|account|subscription|recurring|cleanings)|stop (?:the |my |our )?(?:service|cleanings|recurring)|end (?:my|our|the) (?:service|plan)|no longer need (?:you|the service|cleaning)|don'?t need (?:you|the service|cleaning) (?:any ?more|anymore)|cancel (?:everything|all (?:future|the) (?:visits|cleanings))|cancel (?:it )?(?:permanently|for good|going forward)|(?:we'?re|i'?m) moving (?:out|away))\b/i;
const APPOINTMENT = /\b(when (?:are|is|will) (?:you|the cleaner|someone|they|my|our)|what time|(?:is|has) (?:my|our|the) (?:cleaning|visit|appointment|service)\b.*\b(?:confirmed|booked|scheduled|still on)|(?:are|is) (?:you|they|we) (?:still )?(?:coming|on for)|who(?:'s| is) (?:coming|assigned|cleaning)|which cleaner|eta\b|on (?:the|their) way|running late|next (?:cleaning|visit|appointment)|what(?:'s| is) included|does (?:it|the (?:clean|cleaning|service)) include|is .* included|what do you clean|confirm (?:my|our|the) (?:cleaning|visit|appointment))\b/i;
const BILLING = /\b(invoice|bill(?:ed|ing)?\b|receipt|balance|how much (?:do|did) (?:i|we) owe|amount due|payment|pay (?:my|the|online|link)|paid|charge(?:d)?|deposit|refund|credit card|card on file|statement)\b/i;
const PREFERENCE = /\b(fragrance|scent(?:ed)?|unscented|perfume|bleach|products?|allerg\w*|chemicals?|eco|green products|shoes|pets?|dog|cat|don'?t (?:clean|touch|vacuum|mop|move|use|go in)|(?:please )?(?:skip|avoid|leave) the\b|focus on|extra attention|please (?:also )?make sure|prefer(?:ence)?|instead of the usual|do not (?:clean|touch|use|go in))\b/i;
const ACCESS = /\b(gate code|door code|garage code|lock ?box|lockbox|key ?(?:pad|code|safe)|alarm (?:code)?|access code|entry code|code (?:is|changed|to)|new code|the key (?:is|will be)|hidden key|spare key|key under)\b/i;
const EXTRA = /\b(add (?:on|an?|the)?|also (?:clean|do)|inside (?:the )?(?:oven|fridge|refrigerator|cabinets|windows)|(?:interior )?windows|laundry|fold(?:ing)? (?:the )?laundry|change (?:the )?(?:sheets|linens|bed)|extra (?:hour|room|service)|deep clean (?:the|this time))\b/i;
const NEW_SERVICE = /\b(quote|estimate|another (?:property|house|home|location|office|unit)|second (?:property|home|house|location)|my (?:office|business|rental|airbnb)|move[- ]?out|move[- ]?in|post[- ]?construction|commercial|how much (?:would|does|is) (?:it|a)|new (?:service|location))\b/i;
const COMPLAINT = /\b(missed|didn'?t (?:clean|do|get|vacuum|mop|dust|wipe)|not (?:clean|cleaned|done)|wasn'?t (?:clean|cleaned|done)|still (?:looks |is |was )?dirty|dirty|forgot|unhappy|disappointed|not happy|poor (?:job|work)|terrible|awful|complain\w*|streak\w*|left (?:a mess|it dirty)|not (?:up to|good enough))\b/i;

const SCOPE_ONE = /\b(just (?:this|for this|that|friday|monday|tuesday|wednesday|thursday|saturday|sunday|next)|this (?:time|once|week|visit|friday|monday|tuesday|wednesday|thursday|saturday|sunday) only|only (?:this|for this|that|on friday|on monday|tomorrow|today|next)|for (?:this|that|tomorrow'?s?|friday'?s?|monday'?s?|tuesday'?s?|wednesday'?s?|thursday'?s?|saturday'?s?|sunday'?s?) (?:visit|cleaning|clean|appointment)|one[- ]time)\b/i;
const SCOPE_ALL = /\b(from now on|going forward|every (?:time|visit|cleaning)|all (?:future )?(?:visits|cleanings)|always|permanently|each (?:time|visit)|in (?:the )?future|ongoing)\b/i;
const SCOPE_CUSTOMER = /\b(at all (?:our|my) (?:properties|homes|houses|locations)|everywhere|all (?:our|my) (?:properties|homes|locations))\b/i;

/** "Friday", "fri", "tomorrow", "today", "11/28", "Nov 28" → a local day (YYYY-MM-DD) from `now`, or a weekday. */
function daysIn(text: string, now: number, timezone: string): { day: string; weekday: number; words: string; index: number }[] {
  const lower = text.toLowerCase();
  const out: { day: string; weekday: number; words: string; index: number }[] = [];
  const today = startOfLocalDay(now, timezone);
  const todayWeekday = localParts(now, timezone).weekday;
  const at = (offset: number) => {
    const start = addLocalDays(today, offset, timezone);
    const parts = localParts(start + 12 * 3_600_000, timezone);
    return { day: parts.day, weekday: parts.weekday };
  };
  const push = (entry: { day: string; weekday: number }, words: string, index: number) => {
    if (!out.some((row) => row.index === index)) out.push({ ...entry, words, index });
  };
  for (const match of lower.matchAll(/\b(today|tonight|tomorrow)\b/g)) push(at(match[1] === "tomorrow" ? 1 : 0), match[1], match.index ?? 0);
  for (const match of lower.matchAll(/\b(next |this |coming )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)(?:day)?'?s?\b/g)) {
    const word = match[2];
    const weekday = WEEKDAYS.indexOf(word) >= 0 ? WEEKDAYS.indexOf(word) : SHORT_DAYS[word];
    if (weekday === undefined) continue;
    let offset = (weekday - todayWeekday + 7) % 7;
    if (match[1]?.trim() === "next" && offset === 0) offset = 7;
    push(at(offset), match[0].trim(), match.index ?? 0);
  }
  const year = Number(localParts(now, timezone).day.slice(0, 4));
  const dated = (month: number, date: number, words: string, index: number) => {
    if (month < 1 || month > 12 || date < 1 || date > 31) return;
    for (const y of [year, year + 1]) {
      const day = `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
      if (day >= localParts(now, timezone).day) {
        const noon = Date.UTC(y, month - 1, date, 12);
        push({ day, weekday: new Date(noon).getUTCDay() }, words, index);
        return;
      }
    }
  };
  for (const match of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) dated(Number(match[1]), Number(match[2]), match[0], match.index ?? 0);
  for (const match of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/g)) dated(MONTHS.indexOf(match[1].slice(0, 3)) + 1, Number(match[2]), match[0], match.index ?? 0);
  return out.sort((a, b) => a.index - b.index);
}

/** "10am", "10:30 am", "2 pm", "at 9" (read as morning before 7, afternoon otherwise) → minutes after midnight. */
function timeIn(text: string): { minute: number; words: string } | null {
  const lower = text.toLowerCase();
  const full = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)\b/.exec(lower);
  if (full) {
    let hour = Number(full[1]) % 12;
    if (full[3].startsWith("p")) hour += 12;
    return { minute: hour * 60 + Number(full[2] ?? 0), words: full[0] };
  }
  const bare = /\bat (\d{1,2})(?::(\d{2}))?\b/.exec(lower);
  if (bare) {
    const hour = Number(bare[1]);
    if (hour < 1 || hour > 12) return null;
    return { minute: (hour < 7 ? hour + 12 : hour) * 60 + Number(bare[2] ?? 0), words: bare[0] };
  }
  if (/\bmorning\b/.test(lower)) return { minute: 9 * 60, words: "morning" };
  if (/\bafternoon\b/.test(lower)) return { minute: 13 * 60, words: "afternoon" };
  return null;
}

function scopeIn(text: string): PreferenceScope | undefined {
  if (SCOPE_CUSTOMER.test(text)) return "customer";
  if (SCOPE_ALL.test(text)) return "all_future";
  if (SCOPE_ONE.test(text)) return "one_visit";
  return undefined;
}

/** Access details withheld: digits after a code word, and the rest of a sentence that says where a key is. */
export function withholdAccess(text: string): { text: string; withheld: boolean } {
  let withheld = false;
  let out = text.replace(/\b((?:gate|door|garage|alarm|access|entry|lock ?box|lockbox|key ?pad|keypad|key ?code)?\s?(?:code|combo|combination|pin|password)(?:\s(?:is|was|changed|to|now|=|:))*\s?)([#*]?[A-Za-z]*\d[\w#*-]*)/gi, (_, lead: string) => {
    withheld = true;
    return `${lead}[withheld]`;
  });
  out = out.replace(/\b((?:the |a |spare |hidden )?key (?:is under|is in|is behind|is now|will be|is|under|in|behind))([^.!?\n]*)/gi, (_, lead: string) => {
    withheld = true;
    return `${lead} [withheld]`;
  });
  return { text: out, withheld };
}

/** Splits a message into the parts that may each be a separate request. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+|\s+(?:and also|also,?|plus|oh and|one more thing,?|separately,?|and then)\s+|;\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function readClause(clause: string, now: number, timezone: string): Intent[] {
  const days = daysIn(clause, now, timezone);
  const time = timeIn(clause);
  const scope = scopeIn(clause);
  const words = clause.slice(0, 300);
  const out: Intent[] = [];
  const add = (category: CareCategory, ask: Ask) => out.push({ category, ask, words });

  const access = ACCESS.test(clause);
  if (access) add("access", { detail: withholdAccess(clause).text.slice(0, 300), ...(scope ? { scope } : {}) });

  const ends = END_PLAN.test(clause);
  const pause = PAUSE.test(clause);
  const skip = SKIP.test(clause);
  const cancel = CANCEL_WORD.test(clause);
  const moving = RESCHEDULE.test(clause) && !cancel && !skip;
  if (moving) {
    // "Move Friday's cleaning to Monday": the day after "to" (or "instead") is the new one; the other is the visit.
    const toIndex = clause.toLowerCase().search(/\b(?:to|for|until|instead|on)\b/);
    const newer = days.find((d) => toIndex >= 0 && d.index > toIndex) ?? (days.length === 1 && /\binstead\b|\bcan (?:you|we) (?:come|do)/i.test(clause) ? days[0] : days.length > 1 ? days[days.length - 1] : undefined);
    const target = days.find((d) => d !== newer);
    add("reschedule", {
      ...(target ? { target: { day: target.day, weekday: target.weekday, words: target.words } } : {}),
      ...(newer || time ? { when: { ...(newer ? { day: newer.day, weekday: newer.weekday } : {}), ...(time ? { minute: time.minute } : {}), words: [newer?.words, time?.words].filter(Boolean).join(" ") } } : {}),
    });
  } else if (ends || pause || skip || cancel) {
    const kind: CancelKind | undefined = ends ? "end_plan" : pause ? "pause_plan" : skip ? "skip_visit" : days.length ? "skip_visit" : undefined;
    const target = days[0];
    // A visit-level cancel names a day ("cancel Friday"); with no day and no plan words, it is unclear which is meant.
    const ask: Ask = { ...(kind && !(cancel && !ends && !pause && !skip && !target) ? { cancel: kind } : {}), ...(target ? { target: { day: target.day, weekday: target.weekday, words: target.words } } : {}) };
    if (pause && days.length > 0) ask.when = { day: days[days.length - 1].day, weekday: days[days.length - 1].weekday, words: days[days.length - 1].words };
    add("cancellation", ask);
  }

  const serious = seriousReason(clause);
  if (serious || COMPLAINT.test(clause)) add("complaint", { ...(serious ? { serious } : {}), ...(days[0] ? { target: { day: days[0].day, weekday: days[0].weekday, words: days[0].words } } : {}), detail: clause.slice(0, 300) });

  if (BILLING.test(clause) && !/\b(?:quote|estimate)\b/i.test(clause)) add("billing", {});
  if (APPOINTMENT.test(clause) && !moving) {
    const question: Ask["question"] = /\bwho\b|which cleaner/i.test(clause) ? "who" : /\binclud|what do you clean/i.test(clause) ? "included" : /confirm|booked|scheduled|still on/i.test(clause) ? "confirmed" : "when";
    add("appointment", { question, ...(days[0] ? { target: { day: days[0].day, weekday: days[0].weekday, words: days[0].words } } : {}) });
  }
  if (!access && PREFERENCE.test(clause) && !COMPLAINT.test(clause) && !moving && !(skip && !/\bthe\b/i.test(clause))) {
    add("preference", { detail: clause.slice(0, 300), ...(scope ? { scope } : {}), ...(days[0] ? { target: { day: days[0].day, weekday: days[0].weekday, words: days[0].words } } : {}) });
  }
  if (EXTRA.test(clause) && !COMPLAINT.test(clause)) add("extra", { detail: clause.slice(0, 300), ...(days[0] ? { target: { day: days[0].day, weekday: days[0].weekday, words: days[0].words } } : {}) });
  if (NEW_SERVICE.test(clause) && !out.some((i) => i.category === "extra")) add("new_service", { detail: clause.slice(0, 300) });
  // A preference that is really "skip the guest room" is not a skipped visit.
  if (out.some((i) => i.category === "preference") && out.some((i) => i.category === "cancellation" && i.ask.cancel === "skip_visit" && /\bskip the\b/i.test(clause))) {
    return out.filter((i) => i.category !== "cancellation");
  }
  return out;
}

/** What a short reply might be answering: a numbered choice, yes or no, a day or time, a scope. */
function answerIn(text: string, now: number, timezone: string): Answer | null {
  const trimmed = text.trim().toLowerCase();
  const answer: Answer = {};
  const choice = /^(?:option\s*)?#?([1-5])\b|^(?:the )?(first|second|third|fourth|fifth)(?: one| option)?\b/.exec(trimmed);
  if (choice) answer.choice = choice[1] ? Number(choice[1]) : ["first", "second", "third", "fourth", "fifth"].indexOf(choice[2]) + 1;
  if (YES.test(trimmed)) answer.yes = true;
  else if (NO.test(trimmed)) answer.no = true;
  const days = daysIn(text, now, timezone);
  if (days.length === 1) {
    answer.day = days[0].day;
    answer.weekday = days[0].weekday;
  }
  const time = timeIn(text);
  if (time) answer.minute = time.minute;
  const scope = scopeIn(text);
  if (scope) answer.scope = scope;
  if (END_PLAN.test(text) || /\b(?:the )?whole (?:plan|service|thing)|everything|all of (?:it|them)\b/i.test(text)) answer.cancel = "end_plan";
  else if (PAUSE.test(text)) answer.cancel = "pause_plan";
  else if (/\bjust (?:the|that|this|one)|only (?:the|that|this|one)|one visit|that (?:one|day)\b/i.test(text)) answer.cancel = "skip_visit";
  return Object.keys(answer).length ? answer : null;
}

export function readByRule(text: string, now: number, timezone: string): Reading {
  const body = text.replace(/\s+/g, " ").trim();
  const ack = ACK.test(body);
  const intents: Intent[] = [];
  if (!ack) {
    for (const clause of clauses(text)) {
      for (const intent of readClause(clause, now, timezone)) {
        const same = intents.find((row) => row.category === intent.category);
        // The same request named twice in one message is one request, with both parts' details.
        if (same) {
          same.ask = { ...intent.ask, ...same.ask };
          same.words = `${same.words} ${intent.words}`.slice(0, 300);
        } else intents.push(intent);
      }
    }
  }
  const access = ACCESS.test(body) && withholdAccess(body).withheld;
  return { intents, ack, answer: ack ? null : answerIn(body, now, timezone), serious: seriousReason(body), access, areas: areasIn(body), reader: "rules" };
}

/**
 * A model's reading, kept only where the message supports it: a category the rules also see, or one whose
 * quoted words are in the message. Dates and times always come from the rules, never from the model.
 */
export function checkedReading(model: Reading, rules: Reading, text: string): Reading {
  const lower = text.toLowerCase();
  const kept = model.intents.filter((intent) => rules.intents.some((row) => row.category === intent.category) || (intent.words.trim().length >= 4 && lower.includes(intent.words.trim().toLowerCase().slice(0, 60))));
  const intents = kept.map((intent) => {
    const rule = rules.intents.find((row) => row.category === intent.category);
    return { category: intent.category, words: intent.words.slice(0, 300), ask: { ...(rule?.ask ?? {}), ...(intent.ask.question ? { question: intent.ask.question } : {}), ...(intent.ask.scope && !rule?.ask.scope && scopeIn(text) === intent.ask.scope ? { scope: intent.ask.scope } : {}) } };
  });
  for (const rule of rules.intents) if (!intents.some((row) => row.category === rule.category)) intents.push(rule);
  return { ...rules, intents, ack: rules.ack || (model.ack && intents.length === 0), reader: model.reader };
}
