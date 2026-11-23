"use client";

/**
 * The visit-level review queue: each visit the crew reported done, compared with the standard that applied.
 * A review shows which standard and version applied, each requirement's outcome, the reasons for any flag,
 * the evidence (with what is missing kept beside it), and what was asked of whom. A person approves, asks for
 * something, or opens a case. Closing the visit stays a manager's step on the visit itself.
 */
import { useMutation } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, TextArea, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { whenLabel } from "@/lib/app/format";
import { useStableQuery } from "@/lib/app/stable-query";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { EvidenceSections, Empty, Flag, OpenLink, QUALITY_PATH, RunTrace, useParam, type ReviewDetail } from "./shared";

const OUTCOME_LOOK: Record<string, { icon: typeof CheckCircle2; tone: string; words: string }> = {
  met: { icon: CheckCircle2, tone: "text-success-foreground", words: "Met" },
  missing: { icon: XCircle, tone: "text-warning-foreground", words: "Missing" },
  contradictory: { icon: AlertTriangle, tone: "text-destructive-foreground", words: "Contradictory" },
  unverifiable: { icon: CircleDashed, tone: "text-muted-foreground", words: "A person confirms" },
  not_applicable: { icon: CircleDashed, tone: "text-muted-foreground", words: "Does not apply" },
  waived: { icon: CircleDashed, tone: "text-muted-foreground", words: "Waived" },
};

function Results({ review }: { review: ReviewDetail }) {
  const { companyId } = useCompany();
  const record = useMutation(api.quality.recordCheck);
  const { busy, error, run } = useRun();
  return (
    <div className="grid gap-2">
      <ul className="divide-y divide-border rounded-2xl border border-border bg-background">
        {review.results.map((r) => {
          const look = OUTCOME_LOOK[r.outcome];
          const Icon = look.icon;
          return (
            <li key={r.requirementId} className="grid gap-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Icon className={cn("size-4", look.tone)} aria-hidden />
                <span className="text-sm font-medium text-strong">{r.label}</span>
                <span className={cn("text-xs font-medium", look.tone)}>{look.words}</span>
                <Flag>{r.level === "required" ? "Required" : "Advisory"}</Flag>
              </div>
              <p className="text-sm text-muted-foreground">{r.detail}</p>
              <p className="text-[11px] text-muted-foreground">From: {r.fromWords}</p>
              {r.outcome === "unverifiable" && (review.canClose || true) ? (
                <Button size="xs" variant="outline" className="w-fit" loading={busy} onClick={() => run(() => record({ companyId, reviewId: review.id as Id<"qualityReviews">, requirementId: r.requirementId, note: "Checked by a person on review." }))}>Record that I checked this</Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {review.standard.waived.length ? <p className="text-xs text-muted-foreground">Waived here: {review.standard.waived.map((w) => `${w.label} (${w.reason})`).join("; ")}</p> : null}
      <FormError message={error} />
    </div>
  );
}

export function ReviewBody({ reviewId }: { reviewId: Id<"qualityReviews"> }) {
  const { companyId, timezone, role } = useCompany();
  const now = useNow();
  const review = useStableQuery(api.quality.review, now ? { companyId, reviewId, asOf: now } : "skip");
  const decide = useMutation(api.quality.decideReview);
  const ask = useMutation(api.quality.requestFromCleaner);
  const report = useMutation(api.quality.reportConcern);
  const closeVisit = useMutation(api.jobs.reviewCompletion);
  const { busy, error, run } = useRun();
  const [note, setNote] = useState("");
  if (!review) return <div className="grid gap-3 p-5" aria-busy="true"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  const manage = role !== "office";
  return (
    <div className="grid gap-5 p-4 sm:p-6">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={review.recommendation === "approve" ? "success" : review.recommendation ? "warning" : "outline"} size="sm">{review.statusWords}</Badge>
          {review.historical ? <Flag>Imported: record only</Flag> : null}
          {review.reopened ? <Flag tone="warn">Reopened</Flag> : null}
          <span className="text-xs text-muted-foreground">Submission {review.round}</span>
        </div>
        <h2 className="font-heading text-xl tracking-tight text-strong">{review.job ? `${review.job.customer?.name ?? "A client"} · ${review.job.service}, ${review.job.day}` : "A visit"}</h2>
        <p className="text-sm text-foreground">{review.summary}</p>
        {review.reopened ? <p className="text-sm text-warning-foreground">{review.reopened.reason} The visit still happened; its quality question is open again.</p> : null}
        <p className="text-xs text-muted-foreground">The visit: {review.job?.operational ?? "unknown"}. Quality&rsquo;s review is separate and closes nothing.</p>
      </header>
      <RunTrace checked={review.checked} found={review.found} next={review.next} now={now} timezone={timezone} />
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold text-strong">The standard that applied</h3>
        <p className="text-xs text-muted-foreground">{review.standard.baseline ? "No Quality standard was published: the checklist and Dispatch's photo rules on record were used." : review.standard.sources.map((s) => `${s.levelWords}: ${s.name} v${s.version}`).join(" → ")}. Held as of {whenLabel(review.standard.asOf, now, timezone)}; later edits do not change it.</p>
        <Results review={review} />
      </section>
      {review.flags.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold text-strong">Why it was flagged</h3>
          <ul className="grid gap-1.5 text-sm">{review.flags.map((f) => <li key={f.code + f.text} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />{f.text}</li>)}</ul>
        </section>
      ) : null}
      {review.photos.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold text-strong">Photos</h3>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {review.photos.map((p) => <li key={p.id}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">{/* eslint-disable-next-line @next/next/no-img-element -- a private, signed storage URL; nothing to optimize */}
                      <img src={p.url} alt={`${p.kind} photo`} className="aspect-square w-full rounded-lg border border-border object-cover" loading="lazy" /></a> : null}<span className="text-[11px] text-muted-foreground">{p.kind}</span></li>)}
          </ul>
        </section>
      ) : null}
      <section className="grid gap-2">
        <h3 className="text-sm font-semibold text-strong">The visit&rsquo;s record</h3>
        <EvidenceSections sections={review.evidence} now={now} timezone={timezone} />
      </section>
      {review.requests.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold text-strong">Asked of the crew</h3>
          <ul className="grid gap-2 text-sm">{review.requests.map((r) => <li key={r.id} className="rounded-xl border border-border bg-background px-3.5 py-2.5">{r.purposeWords} · {r.who} · <span className="font-medium">{r.statusWords}</span>{r.result ? <span className="text-muted-foreground"> · {r.result}</span> : null}</li>)}</ul>
        </section>
      ) : null}
      {review.case ? <p className="text-sm">Case: <OpenLink href={`${QUALITY_PATH}/cases?case=${review.case.id}`}>{review.case.title}</OpenLink></p> : null}
      {manage && !review.decision && review.status !== "superseded" ? (
        <section className="grid gap-3 rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold text-strong">Decide</h3>
          <TextArea placeholder={review.recommendation !== "approve" ? "Say why, if you approve against Quality's recommendation" : "Note (optional)"} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy} onClick={() => run(() => decide({ companyId, reviewId: review.id as Id<"qualityReviews">, outcome: "approved", note: note || undefined }))}>Approve the review</Button>
            {review.crew[0] && review.job ? <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => ask({ companyId, jobId: review.job!.id as Id<"jobs">, cleanerId: review.crew[0].cleanerId as Id<"cleaners">, purpose: "missing_evidence", questions: [], photos: [{ label: "An after photo of the finished work", photoKind: "after" }] }))}>Ask {review.crew[0].name} for a photo</Button> : null}
            {review.job ? <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => report({ companyId, jobId: review.job!.id as Id<"jobs">, words: note || "Opened from the review for a closer look." }))}>Open a case</Button> : null}
            {review.canClose && review.job ? <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => closeVisit({ companyId, jobId: review.job!.id as Id<"jobs">, decision: "close", note: note || undefined }))}>Close the visit</Button> : null}
          </div>
          <p className="text-xs text-muted-foreground">Approving records Quality&rsquo;s decision. Closing the visit is the manager&rsquo;s own step; neither approves pay.</p>
          <FormError message={error} />
        </section>
      ) : review.decision ? <p className="text-sm text-muted-foreground">Decided by {review.decision.by}: {review.decision.outcome.replace(/_/g, " ")}{review.decision.note ? ` · ${review.decision.note}` : ""}</p> : null}
    </div>
  );
}

export function ReviewDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetPopup side="right" className="w-full max-w-3xl bg-background">
        <SheetTitle className="sr-only">Visit review</SheetTitle>
        <ScrollArea className="min-h-0 flex-1">{id ? <ReviewBody reviewId={id as Id<"qualityReviews">} /> : null}</ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}

export function QualityReviewsScreen() {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const [scope, setScope] = useState<"open" | "all">("open");
  const reviews = useStableQuery(api.quality.reviews, { companyId, status: scope });
  const { openId, open, close } = useParam("review");
  return (
    <>
      <PageHeader title="Reviews" lead="Every visit the crew reports done, compared with the standard that applied. A complete record is documentation, not proof of how the service looked." />
      <div className="mb-4 flex gap-2" role="group" aria-label="Which reviews">
        {(["open", "all"] as const).map((s) => <Button key={s} size="sm" variant={scope === s ? "secondary" : "ghost"} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === "open" ? "Open" : "All recent"}</Button>)}
      </div>
      <Panel flush>
        {reviews === undefined ? (
          <div className="grid gap-2 p-4" aria-busy="true"><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>
        ) : reviews.length ? (
          <ul className="divide-y divide-border">
            {reviews.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => open(r.id)} className="grid w-full gap-1.5 px-4 py-3.5 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-brand-500 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-strong">{r.job ? `${r.job.customer?.name ?? "A client"} · ${r.job.service}, ${r.job.day}` : "A visit"}</span>
                    <span className="block text-xs text-muted-foreground">{r.words ?? r.statusWords}{r.flags.length ? ` · ${r.flags[0].text}` : ""}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">{r.completeness.required ? `${r.completeness.met} of ${r.completeness.required} required met` : "No required items"}</span>
                    {r.reopened ? <Flag tone="warn">Reopened</Flag> : null}
                    {r.historical ? <Flag>Imported</Flag> : null}
                    <Badge variant={r.status === "needs_decision" ? "warning" : r.status === "approved" ? "success" : "outline"} size="sm">{r.statusWords}</Badge>
                    <span>{whenLabel(r.updatedAt, now, timezone)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-4"><Empty title="No visits to review" body="When a crew reports a visit done, Quality reviews it against your standard and it appears here." /></div>
        )}
      </Panel>
      <ReviewDrawer id={openId} onClose={close} />
    </>
  );
}
