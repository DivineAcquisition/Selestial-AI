/**
 * The hiring pipeline as a board. Columns are the application's own stages, grouped; they are not a
 * second status. Moving a card does what the matching button does and nothing more: send the link,
 * invite to interview, hold for a decision, start an offer, or close. Columns the system moves people
 * into (applying, screening, onboarding) take no drops: the applicant or a finished step puts them there.
 */
import type { Stage } from "./schema";

export const COLUMNS = [
  { id: "inbox", label: "Inbox", stages: ["received", "contact_needed"] },
  { id: "invite", label: "Invited", stages: ["invitation_awaiting_approval", "invited"] },
  { id: "apply", label: "Applying", stages: ["application_started"] },
  { id: "screen", label: "Screening", stages: ["application_submitted", "screening"] },
  { id: "interview", label: "Interview", stages: ["interview"] },
  { id: "decide", label: "Decision", stages: ["decision_pending"] },
  { id: "offer", label: "Offer", stages: ["offer_sent", "accepted"] },
  { id: "onboard", label: "Onboarding", stages: ["onboarding_handoff"] },
  { id: "closed", label: "Closed", stages: ["withdrawn", "closed"] },
] as const satisfies readonly { id: string; label: string; stages: readonly Stage[] }[];
export type ColumnId = (typeof COLUMNS)[number]["id"];
export const COLUMN_IDS = COLUMNS.map((column) => column.id) as unknown as readonly [ColumnId, ColumnId, ...ColumnId[]];

export function columnOf(stage: Stage): ColumnId {
  return COLUMNS.find((column) => (column.stages as readonly Stage[]).includes(stage))!.id;
}

export type Move = "invite" | "invite_again" | "interview" | "hold" | "offer" | "close";

/** What dropping an application in a column does, in words a person confirms. Null: that drop isn't allowed. */
export function moveFor(stage: Stage, to: ColumnId): { move: Move; words: string; needs?: "reason" | "closure" } | null {
  const from = columnOf(stage);
  if (from === to || from === "closed") return null;
  switch (to) {
    case "invite":
      if (stage === "received" || stage === "contact_needed" || stage === "invitation_awaiting_approval") return { move: "invite", words: "Sends the application link by email now." };
      if (stage === "invited" || stage === "application_started") return { move: "invite_again", words: "Sends a new application link. The old link stops working." };
      return null;
    case "interview":
      return stage === "screening" || stage === "decision_pending" ? { move: "interview", words: "Invites them to interview. Recruiter offers your open interview times." } : null;
    case "decide":
      return stage === "screening" || stage === "interview" ? { move: "hold", words: "Holds them for a decision. Nothing is sent to the applicant.", needs: "reason" } : null;
    case "offer":
      return stage === "screening" || stage === "interview" || stage === "decision_pending" ? { move: "offer", words: "Starts an offer from the role's approved terms. It waits in Decision until you approve and send it." } : null;
    case "closed":
      return stage === "onboarding_handoff" || stage === "accepted" ? null : { move: "close", words: "Closes the application for the reason you choose. The applicant is told only if you say so.", needs: "closure" };
    default:
      return null;
  }
}
