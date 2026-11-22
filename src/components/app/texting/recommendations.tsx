"use client";

/**
 * Selestial's recommendations for the step in view: who is responsible (a Selestial check or an existing
 * agent), the issue, the rule behind it, the proposed change and its effect, the approval it needs, and the
 * next action. Every action names the exact facts it was shown; if they changed, the server refuses and the
 * recommendation is shown again as it is now.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { FormError, TextArea, useRun } from "@/components/app/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { api } from "../../../../convex/_generated/api";
import { useSetup, type StepId } from "./context";
import { Disclosure } from "./parts";

type Rec = NonNullable<FunctionReturnType<typeof api.textingCase.workspace>>["recommendations"][number];

const AGENT_WORDS: Record<string, string> = { sales: "Sales", recruiter: "Recruiter", dispatch: "Dispatch", retention: "Retention" };
const STATUS: Record<Rec["status"], { label: string; variant: "outline" | "info" | "success" | "warning" }> = {
  open: { label: "Suggested", variant: "info" },
  approved: { label: "Approved", variant: "success" },
  applied: { label: "Applied", variant: "success" },
  dismissed: { label: "Dismissed", variant: "outline" },
  clarification: { label: "Question asked", variant: "outline" },
  stale: { label: "Details changed", variant: "warning" },
  resolved: { label: "No longer applies", variant: "outline" },
};
const APPROVAL: Record<Rec["approval"], string> = { none: "No approval needed", owner: "Needs your approval", owner_and_charges: "Needs your approval; any fee is authorized separately when you submit" };

export function Recommendations({ step }: { step: StepId }) {
  const { companyId } = useSetup();
  const data = useQuery(api.textingCase.workspace, { companyId });
  if (!data) return null;
  const rows = data.recommendations.filter((row) => row.stage === step || (step === "review" && row.status !== "applied" && row.status !== "dismissed"));
  const live = rows.filter((row) => row.status !== "applied" && row.status !== "dismissed");
  const done = rows.filter((row) => row.status === "applied" || row.status === "dismissed");
  if (!rows.length) return null;
  return (
    <section className="grid gap-2" aria-label="Recommendations">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recommendations</h3>
      <ul className="grid gap-2">
        {live.map((row) => (
          <RecommendationCard key={row.id} rec={row} owner={data.viewer.kind === "owner"} manage={data.viewer.manage} />
        ))}
      </ul>
      {done.length ? (
        <Disclosure summary={`Done (${done.length})`}>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {done.map((row) => (
              <li key={row.id}>
                {STATUS[row.status].label}: {row.issue}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <p className="text-[11px] text-muted-foreground">Checks against known carrier requirements. Passing them doesn&apos;t guarantee the carriers&apos; approval.</p>
    </section>
  );
}

function RecommendationCard({ rec, owner, manage }: { rec: Rec; owner: boolean; manage: boolean }) {
  const { companyId, go } = useSetup();
  const act = useMutation(api.textingCase.actOnRecommendation);
  const { busy, error, run } = useRun();
  const [mode, setMode] = useState<"edit" | "clarify" | null>(null);
  const [text, setText] = useState(rec.proposal.kind === "draft_text" ? rec.proposal.text : "");
  const [question, setQuestion] = useState("");
  const send = (action: "apply" | "edit" | "dismiss" | "clarify" | "approve", extra: { text?: string; question?: string } = {}) => run(async () => (await act({ companyId, recommendationId: rec.id, fingerprint: rec.fingerprint, action, ...extra }), setMode(null)));
  const who = rec.responsible.kind === "agent" ? `${AGENT_WORDS[rec.responsible.agent] ?? rec.responsible.agent} agent` : "Selestial check";
  const canApply = rec.proposal.kind === "draft_text" || rec.proposal.kind === "add_evidence";
  const ownerDecision = owner && manage;
  return (
    <li className="grid gap-2 rounded-lg border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={STATUS[rec.status].variant} size="sm">
          {STATUS[rec.status].label}
        </Badge>
        <span className="text-muted-foreground">{who}</span>
      </div>
      <p className="text-sm text-strong">{rec.issue}</p>
      <p className="text-strong">
        <span className="font-medium">Proposed: </span>
        {rec.proposalWords}
      </p>
      <Disclosure summary="Why, and what it changes">
        <dl className="grid gap-1 text-muted-foreground">
          <div>
            <dt className="inline font-medium text-strong">Based on: </dt>
            <dd className="inline">{rec.basisWords}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-strong">Effect: </dt>
            <dd className="inline">{rec.effect}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-strong">Approval: </dt>
            <dd className="inline">{APPROVAL[rec.approval]}</dd>
          </div>
          {rec.proposal.kind === "draft_text" ? <dd className="mt-1 rounded bg-muted px-2 py-1 whitespace-pre-wrap text-strong">{rec.proposal.text}</dd> : null}
        </dl>
      </Disclosure>
      <p className="text-muted-foreground">
        <span className="font-medium text-strong">Next: </span>
        {rec.nextAction}
      </p>
      {rec.clarification ? <p className="text-muted-foreground">You asked: {rec.clarification.question}</p> : null}
      {mode === "edit" ? (
        <form className="grid gap-2" onSubmit={(event) => (event.preventDefault(), void send("edit", { text }))}>
          <TextArea rows={5} value={text} onChange={(event) => setText(event.target.value)} aria-label="Edit the suggested wording" />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy}>
              Use my version
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : mode === "clarify" ? (
        <form className="grid gap-2" onSubmit={(event) => (event.preventDefault(), void send("clarify", { question }))}>
          <TextArea rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} aria-label="Your question for Selestial" required />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={busy}>
              Ask Selestial
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : manage ? (
        <div className="flex flex-wrap gap-1.5">
          {canApply ? (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void send("apply")}>
              {rec.proposal.kind === "add_evidence" ? "Add placeholder" : "Apply draft change"}
            </Button>
          ) : null}
          {rec.proposal.kind === "draft_text" ? (
            <Button size="sm" variant="outline" onClick={() => setMode("edit")}>
              Edit suggestion
            </Button>
          ) : null}
          {rec.proposal.kind === "open_step" || rec.proposal.kind === "start_correction" ? (
            <Button size="sm" variant="outline" onClick={() => void go(rec.proposal.kind === "open_step" ? rec.proposal.step : "activities")}>
              Open the step
            </Button>
          ) : null}
          {rec.proposal.kind === "review_copy" ? (
            <Button size="sm" variant="outline" onClick={() => document.getElementById("evidence-notes")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Go to Evidence & notes
            </Button>
          ) : null}
          {ownerDecision && rec.approval !== "none" && rec.status !== "approved" && (rec.proposal.kind === "confirm_field" || rec.proposal.kind === "start_correction" || rec.proposal.kind === "draft_text") ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => void send("approve")}>
              {rec.proposal.kind === "confirm_field" ? "Confirm it's right" : "Approve action"}
            </Button>
          ) : null}
          {ownerDecision ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setMode("clarify")}>
                Request clarification
              </Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void send("dismiss")}>
                Dismiss
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <FormError message={error} />
    </li>
  );
}
