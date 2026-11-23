/**
 * The guided onboarding, as one pure function: which steps a worker sees, in what order, what each step is
 * made of, whether it is theirs to do, with the office, or finished, and what depends on what.
 *
 * It is built on readiness (readiness.ts), never beside it: a step's state is read from the same requirement
 * views Dispatch uses, so the cleaner's page, the owner's profile, Recruiter's reminders and Dispatch can never
 * disagree. A requirement is only a step for someone who was given it. Steps are structured types, not a
 * workflow engine: the company chooses which steps apply and what they hold up (the template) and what each
 * shows (lib/cleaners/onboarding.ts); the order and the meaning of "done" are fixed here.
 */
import type { RequirementView } from "./readiness";

export const STEP_TYPES = ["signature", "contact_verification", "checklist", "guide_acknowledgment", "payment_setup", "document_upload", "training"] as const;
export type StepType = (typeof STEP_TYPES)[number];

/**
 * todo: the cleaner has something to do. needs_changes: the office sent it back, with what to change.
 * office_review: the cleaner's part is finished and a person is checking it. waiting_on_office: nothing the
 * cleaner can do until the office acts (for example, sending the agreement). done: met. not_needed: waived.
 */
export type StepState = "todo" | "needs_changes" | "office_review" | "waiting_on_office" | "done" | "not_needed";

export type Step = {
  /** The step's main requirement key; stable, used in links (`?step=`). */
  id: string;
  type: StepType;
  number: number;
  title: string;
  description: string | null;
  /** Every requirement this step answers: the contact step also covers weekly hours and areas; pay covers tax. */
  keys: string[];
  state: StepState;
  /** An unmet requirement in it holds up work. */
  blocksWork: boolean;
  /** Steps that must be finished (by the cleaner) first, and whether that holds this one now. */
  dependsOn: string[];
  locked: boolean;
  /** The reviewer's words when it was sent back. */
  changes: string | null;
  /** Inside the step, the parts still open (for example "Weekly availability" in the contact step). */
  open: string[];
};

export type JourneyState = "in_progress" | "office_review" | "steps_finished" | "ready" | "not_active";

export type Journey = {
  state: JourneyState;
  steps: Step[];
  /** Steps whose cleaner part is finished (done, not needed, or with the office), out of all steps. */
  finished: number;
  total: number;
  /** The first step the cleaner can act on now. */
  next: string | null;
  /** Requirement keys the cleaner can act on now: what a reminder may mention, and nothing else. */
  actionable: string[];
};

/** Facts outside the requirement rows that only change who acts next, never whether something is met. */
export type StepFacts = {
  /** An agreement was sent for this worker's signature and they have not signed it yet. */
  agreementToSign: boolean;
  /** They signed; the company's own signature is still outstanding. */
  agreementSignedByWorker: boolean;
  /** The tax document needs something only the worker can give (awaiting information or confirmation). */
  taxNeedsWorker: boolean;
  /** Required training modules exist for them to take. Without any, training is the office's to record. */
  trainingModules: number;
  /** The readiness state, for the overall journey. */
  readiness: "ready" | "blocked" | "onboarding" | "not_active";
};

const ORDER: Record<StepType, number> = { signature: 10, contact_verification: 20, checklist: 30, guide_acknowledgment: 40, payment_setup: 60, document_upload: 70, training: 90 };
/** Within guides, how jobs work comes before expectations, and a company's own acknowledgments after them. */
const GUIDE_ORDER: Record<string, number> = { job_day: 0, policies: 1 };

/** Sensitive details (pay and tax) are asked only once the person proved they hold the phone. */
const DEPENDS: Partial<Record<StepType, StepType[]>> = { payment_setup: ["contact_verification"] };

function typeOf(view: RequirementView): StepType | "folded" | "background" {
  switch (view.kind) {
    case "agreement":
      return "signature";
    case "contact":
      return "contact_verification";
    case "availability":
    case "service_areas":
      return "folded";
    case "equipment":
      return "checklist";
    case "acknowledgment":
      return "guide_acknowledgment";
    case "payment":
      return "payment_setup";
    case "tax":
      return "background";
    case "training":
      return "training";
    default:
      return "document_upload";
  }
}

const TITLES: Partial<Record<StepType, string>> = {
  signature: "Review and sign your agreement",
  contact_verification: "Verify your phone and confirm your details",
  checklist: "Check your supplies",
  payment_setup: "Set up how you get paid",
  training: "Complete your training",
};

const met = (view: RequirementView) => view.met;
const waiting = (view: RequirementView) => view.state === "awaiting_review" || view.state === "submitted";
const sentBack = (view: RequirementView) => view.state === "needs_changes" || view.state === "expired";

/** The state of a plain step: one the cleaner completes by acting, that a person may then check. */
function plainState(views: RequirementView[]): StepState {
  if (views.every(met)) return views.every((view) => view.state === "waived") ? "not_needed" : "done";
  if (views.some(sentBack)) return "needs_changes";
  const open = views.filter((view) => !view.met);
  if (open.some((view) => view.cleanerCompletes && view.state === "not_started")) return "todo";
  if (open.some(waiting)) return "office_review";
  return "waiting_on_office";
}

export function onboardingJourney(views: RequirementView[], facts: StepFacts): Journey {
  const groups = new Map<string, { type: StepType; views: RequirementView[]; sort: number }>();
  const folded: RequirementView[] = [];
  const background: RequirementView[] = [];
  for (const view of views) {
    const type = typeOf(view);
    if (type === "folded") folded.push(view);
    else if (type === "background") background.push(view);
    else {
      // Guides and documents are a step each; the other types are one step however many requirements.
      const id = type === "guide_acknowledgment" || type === "document_upload" ? view.key : type;
      const sort = ORDER[type] + (type === "guide_acknowledgment" ? (GUIDE_ORDER[view.key] ?? 5) : 0);
      const group = groups.get(id) ?? { type, views: [], sort };
      group.views.push(view);
      groups.set(id, group);
    }
  }
  // Weekly hours and areas are short sections of the details step; tax is answered inside the pay step.
  if (folded.length) {
    const contact = groups.get("contact_verification");
    if (contact) contact.views.push(...folded);
    else groups.set("contact_verification", { type: "contact_verification", views: folded, sort: ORDER.contact_verification });
  }
  if (background.length) groups.get("payment_setup")?.views.push(...background);

  const ordered = [...groups.values()].sort((a, b) => a.sort - b.sort || a.views[0].key.localeCompare(b.views[0].key));
  const steps: Step[] = ordered.map((group, index) => {
    const main = group.views[0];
    let state = plainState(group.views);
    if (group.type === "signature") {
      if (group.views.every(met)) state = "done";
      else if (facts.agreementSignedByWorker) state = "office_review";
      else if (facts.agreementToSign) state = "todo";
      else state = group.views.some(sentBack) ? "needs_changes" : "waiting_on_office";
    }
    if (group.type === "payment_setup") {
      const pay = group.views.filter((view) => view.kind === "payment");
      const tax = group.views.filter((view) => view.kind === "tax");
      // The cleaner's part: a preference chosen, and anything the tax document needs from them. Tax being
      // prepared, or failing on the office's side, is never left on the cleaner as an unexplained gap.
      const payState = pay.length ? plainState(pay) : "done";
      if (payState === "todo" || payState === "needs_changes") state = payState;
      else if (facts.taxNeedsWorker && tax.some((view) => !view.met)) state = "todo";
      else if (group.views.every(met)) state = "done";
      else state = "office_review";
    }
    if (group.type === "training" && facts.trainingModules === 0 && state === "todo") state = "waiting_on_office";
    return {
      id: main.key,
      type: group.type,
      number: index + 1,
      title: TITLES[group.type] ?? main.label,
      description: main.description ?? null,
      keys: group.views.map((view) => view.key),
      state,
      blocksWork: group.views.some((view) => view.effect === "blocks_assignments" && !view.met),
      dependsOn: [],
      locked: false,
      changes: group.views.find(sentBack)?.reviewNote ?? null,
      open: group.views.filter((view) => !view.met && view !== main && view.kind !== "tax").map((view) => view.label),
    };
  });
  const cleanerFinished = (step: Step) => step.state === "done" || step.state === "not_needed" || step.state === "office_review";
  for (const step of steps) {
    const needs = DEPENDS[step.type] ?? [];
    step.dependsOn = steps.filter((other) => needs.includes(other.type)).map((other) => other.id);
    step.locked = steps.some((other) => step.dependsOn.includes(other.id) && !cleanerFinished(other)) && !cleanerFinished(step);
  }
  const actionableSteps = steps.filter((step) => (step.state === "todo" || step.state === "needs_changes") && !step.locked);
  const finished = steps.filter(cleanerFinished).length;
  const anyTodo = steps.some((step) => step.state === "todo" || step.state === "needs_changes");
  let state: JourneyState;
  if (facts.readiness === "not_active") state = "not_active";
  else if (facts.readiness === "ready" && !anyTodo) state = "ready";
  else if (anyTodo) state = "in_progress";
  else if (steps.some((step) => step.state === "office_review")) state = "office_review";
  else state = facts.readiness === "ready" ? "ready" : "steps_finished";
  const byKey = new Map(views.map((view) => [view.key, view]));
  const actionable = actionableSteps.flatMap((step) =>
    step.keys
      .map((key) => byKey.get(key)!)
      .filter((view) => !view.met && (view.kind === "tax" ? facts.taxNeedsWorker : view.kind === "agreement" ? facts.agreementToSign : view.cleanerCompletes && !waiting(view)))
      .map((view) => view.key),
  );
  return { state, steps, finished, total: steps.length, next: actionableSteps[0]?.id ?? null, actionable };
}

/** The cleaner-facing words for the journey's state. */
export const JOURNEY_WORDS: Record<JourneyState, { title: string; body: string }> = {
  in_progress: { title: "Continue setup", body: "A few steps left. Your progress is saved as you go." },
  office_review: { title: "Office review", body: "Your steps are finished. The office is checking what you sent and will let you know." },
  steps_finished: { title: "Your steps are finished", body: "There is nothing more for you to do. The office makes your account active." },
  ready: { title: "Ready for assignments", body: "You can be offered jobs that match your hours and areas." },
  not_active: { title: "Not active", body: "Your account is not active right now. Contact the office with any question." },
};

export const STEP_STATE_WORDS: Record<StepState, string> = {
  todo: "To do",
  needs_changes: "Needs a change",
  office_review: "With the office",
  waiting_on_office: "Waiting on the office",
  done: "Done",
  not_needed: "Not needed",
};
