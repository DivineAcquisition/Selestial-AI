import type { Doc } from "../_generated/dataModel";

/**
 * The reasons a person can pick when they skip a proposal or take it over, so a "no" is one tap and the
 * agent gets the same words every time. Each list fits the kind of proposal; "Other" is always free text.
 */
export type DecisionReason = {
  code: string;
  label: string;
  /** When set, the person may keep this reason as a standing rule; the words say what the rule does. */
  remember?: string;
  /** Written by the agent for this one proposal, not taken from the list for its kind. */
  suggested?: boolean;
};
export type DecisionReasons = { skip: DecisionReason[]; change: DecisionReason[] };

type ProposalKind = NonNullable<Doc<"approvals">["proposal"]>["kind"];

const r = (code: string, label: string, remember?: string): DecisionReason => (remember ? { code, label, remember } : { code, label });

const AVOID_PAIR = "Don't propose this cleaner for this customer again";

const DISPATCH_OFFER: DecisionReasons = {
  skip: [
    r("not_a_fit", "Not the right cleaner for this client", AVOID_PAIR),
    r("client_request", "The customer asked for someone else", AVOID_PAIR),
    r("cleaner_busy", "This cleaner has enough on"),
    r("pay_wrong", "The pay doesn't look right"),
  ],
  change: [
    r("contact_myself", "I'll contact the cleaner myself"),
    r("other_cleaner", "I'll offer it to someone else"),
    r("change_visit", "The visit needs to move or change first"),
  ],
};

const CLEANER_MESSAGE: DecisionReasons = {
  skip: [r("already_handled", "Already handled"), r("bad_timing", "Wrong time to send it"), r("wording", "The wording isn't right")],
  change: [r("contact_myself", "I'll message the cleaner myself")],
};

const RECRUITING: DecisionReasons = {
  skip: [r("not_a_fit", "Not a fit for the role"), r("not_hiring", "Not hiring for this right now"), r("wrong_step", "Wrong step for this applicant"), r("wording", "The wording or terms aren't right")],
  change: [r("contact_myself", "I'll contact the applicant myself"), r("adjust_terms", "I'll change the terms first")],
};

const SALES: DecisionReasons = {
  skip: [r("wording", "The message isn't right"), r("price", "The price isn't right"), r("too_soon", "Too soon to follow up"), r("not_interested", "The customer isn't interested")],
  change: [r("contact_myself", "I'll talk to the customer myself"), r("edit_first", "I'll edit it before it goes")],
};

const PRICE: DecisionReasons = {
  skip: [r("price", "The price isn't right"), r("not_agreed", "The customer hasn't agreed to it"), r("not_now", "Not now")],
  change: [r("different_price", "I'll set a different price"), r("contact_myself", "I'll talk to the customer first")],
};

const RETENTION: DecisionReasons = {
  skip: [r("too_generous", "More than this concern warrants"), r("not_warranted", "Not warranted for this concern"), r("wording", "The message isn't right")],
  change: [r("contact_myself", "I'll talk to the customer myself"), r("different_remedy", "I'll offer something different")],
};

const QUALITY: DecisionReasons = {
  skip: [r("not_needed", "Not needed for this visit"), r("evidence", "The evidence doesn't support it"), r("wording", "The wording isn't right")],
  change: [r("contact_myself", "I'll handle it with the crew myself")],
};

const GENERAL: DecisionReasons = {
  skip: [r("not_needed", "Not needed"), r("not_now", "Not now"), r("something_wrong", "Something in it is wrong")],
  change: [r("do_myself", "I'll do it my own way")],
};

const BY_KIND: Record<ProposalKind, DecisionReasons> = {
  offer_assignment: DISPATCH_OFFER,
  send_reminder: CLEANER_MESSAGE,
  send_cleaner_follow_up: CLEANER_MESSAGE,
  send_invitation: RECRUITING,
  send_follow_up: RECRUITING,
  request_information: RECRUITING,
  invite_to_interview: RECRUITING,
  send_hiring_offer: RECRUITING,
  decline_application: RECRUITING,
  urgent_outreach: RECRUITING,
  sales_payment_link: SALES,
  sales_action: SALES,
  sales_quote: SALES,
  sales_price_override: PRICE,
  plan_change: PRICE,
  proposal_rates: PRICE,
  retention_action: RETENTION,
  quality_request: QUALITY,
  quality_improvement: QUALITY,
};

/** The agent's own reasons for this proposal first, then the list for its kind. */
export function reasonsFor(approval: Pick<Doc<"approvals">, "proposal" | "suggestedReasons">): DecisionReasons {
  const base = approval.proposal ? BY_KIND[approval.proposal.kind] : GENERAL;
  const merge = (own: { code: string; label: string }[] | undefined, list: DecisionReason[]) => {
    const first = (own ?? []).map((row) => ({ code: row.code, label: row.label, suggested: true }));
    return [...first, ...list.filter((row) => !first.some((mine) => mine.code === row.code))];
  };
  return { skip: merge(approval.suggestedReasons?.skip, base.skip), change: merge(approval.suggestedReasons?.change, base.change) };
}

const MAX_SUGGESTED = 3;

/** An agent's suggested reasons, checked: short words, codes that cannot collide with the list's, at most three of each. */
export function cleanSuggestions(input: { skip?: { code: string; label: string }[]; change?: { code: string; label: string }[] } | undefined) {
  if (!input) return undefined;
  const clean = (rows: { code: string; label: string }[] | undefined) =>
    (rows ?? [])
      .map((row) => ({ code: `agent:${row.code.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40)}`, label: row.label.trim().slice(0, 120) }))
      .filter((row) => row.label.length > 0 && row.code.length > "agent:".length)
      .slice(0, MAX_SUGGESTED);
  const skip = clean(input.skip);
  const change = clean(input.change);
  return skip.length || change.length ? { skip, change } : undefined;
}

/**
 * The note an approval keeps: the picked reason's words, then whatever the person added. Everything that
 * reads the note downstream (case histories, task questions) gets plain words either way.
 */
export function decisionNote(reason: DecisionReason | null, words: string | undefined): string | undefined {
  if (!reason) return words;
  return words ? `${reason.label}: ${words}` : reason.label;
}
