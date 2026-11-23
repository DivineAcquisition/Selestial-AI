/**
 * The job evidence assembler: everything relevant to one visit, gathered from where it lives, for the
 * person (or agent) asking, and nothing beyond what is relevant.
 *
 * It says what it found, what it looked for and did not find, what it could not access, what is still
 * processing, what may be stale and what needs a person to confirm it belongs to this visit. A provider
 * that is not connected is "not connected", never "no conversations". A photo's time is when it reached
 * Selestial; no capture time, location or missing event is ever made up.
 *
 * It reads; it never judges. The review engine (lib/quality/review.ts) compares these facts with the
 * standard. Personnel records are limited to the crew's readiness for this kind of work; a cleaner's wider
 * history and a customer's unrelated history are not collected because they are accessible.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { serviceTerms } from "../agreements/agents";
import { jobAssignments } from "../dispatch/facts";
import { jobChecklist, jobEvidence } from "../dispatch/live";
import { clock, dayName } from "../time";
import { isOwner, type Role } from "../roles";
import { qualitySettings } from "./settings";
import type { EvidenceBasis, QualitySource } from "./schema";
import { DAY, HOUR } from "./words";

type Ctx = QueryCtx | MutationCtx;

/** Who is asking. The agent reads what it needs to review; a person sees what their role may see. */
export type Viewer = { kind: "agent" } | { kind: "member"; role: Role; memberId: Id<"members"> };

export type GapState = "not_found" | "no_access" | "not_connected" | "processing" | "stale" | "needs_association" | "restricted";

export type EvidenceItem = { label: string; detail: string; basis: EvidenceBasis; at?: number; atKind?: "scheduled" | "occurred" | "received" | "recorded"; source?: QualitySource };
export type EvidenceGap = { state: GapState; what: string; source?: QualitySource };
export type SectionId = "promise" | "execution" | "communications" | "financial" | "history";
export type Section = { id: SectionId; title: string; items: EvidenceItem[]; gaps: EvidenceGap[] };

export type ChecklistFact = { id: Id<"checklistItems">; label: string; section: string | null; state: "pending" | "done" | "skipped"; skipReason: string | null; requiresPhoto: boolean; photos: number; at: number | null };
export type PhotoFact = { id: Id<"evidence">; kind: "before" | "after" | "item" | "issue"; checklistItemId: Id<"checklistItems"> | null; uploadedAt: number; cleanerId: Id<"cleaners"> };
export type CrewFact = { assignmentId: Id<"assignments">; cleanerId: Id<"cleaners">; name: string; role: string | null; status: Doc<"assignments">["status"]; checkInAt: number | null; lateReported: boolean; submittedAt: number | null; incomplete: boolean; note: string | null; payCents: number; offerKind: string | null };

/** The structured facts the review engine works from. */
export type JobFacts = {
  job: Doc<"jobs">;
  customer: Doc<"customers"> | null;
  property: Doc<"properties"> | null;
  scope: { included: string[]; excluded: string[] };
  checklist: ChecklistFact[];
  photos: PhotoFact[];
  crew: CrewFact[];
  reports: { id: Id<"jobReports">; kind: Doc<"jobReports">["kind"]; text: string; status: Doc<"jobReports">["status"]; at: number; cleanerId: Id<"cleaners"> }[];
  acknowledgments: { cleanerId: Id<"cleaners">; key: string; label: string; acknowledgedAt: number | null; accepted: boolean }[];
  firstVisit: boolean;
  recurring: boolean;
  visitNumber: number;
  historical: boolean;
};

export type Assembled = { facts: JobFacts; sections: Section[]; stamp: string };

export function splitScope(scope: string): { included: string[]; excluded: string[] } {
  const included: string[] = [];
  let excluded: string[] = [];
  for (const line of scope.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) included.push(trimmed.slice(2));
    else if (/^not included:/i.test(trimmed)) excluded = trimmed.replace(/^not included:/i, "").replace(/\.$/, "").split(";").map((part) => part.trim()).filter(Boolean);
  }
  return { included, excluded };
}

const src = (table: string, id: string, label: string, at?: number): QualitySource => ({ table, id, label, ...(at !== undefined ? { at } : {}) });
const day = (at: number, tz: string) => dayName(at, tz);

/** Whether this visit came from an import: reviewed for the record, never a reason to contact anyone. */
export async function isHistorical(ctx: Ctx, job: Doc<"jobs">): Promise<boolean> {
  const records = await ctx.db
    .query("migrationRecords")
    .withIndex("by_company_customer", (q) => q.eq("companyId", job.companyId).eq("customerId", job.customerId))
    .take(200);
  return records.some((r) => r.jobId === job._id);
}

async function visitFacts(ctx: Ctx, job: Doc<"jobs">): Promise<{ firstVisit: boolean; recurring: boolean; visitNumber: number }> {
  const earlier = await ctx.db
    .query("jobs")
    .withIndex("by_company_property_start", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId).lt("startsAt", job.startsAt))
    .order("desc")
    .take(200);
  const completedBefore = earlier.filter((j) => j.status === "completed" && j.recovery === undefined).length;
  return { firstVisit: completedBefore === 0, recurring: job.planId !== undefined, visitNumber: completedBefore + 1 };
}

export async function jobFacts(ctx: Ctx, job: Doc<"jobs">): Promise<JobFacts> {
  const customer = await ctx.db.get(job.customerId);
  const property = await ctx.db.get(job.propertyId);
  const items = await jobChecklist(ctx, job);
  const photos = await jobEvidence(ctx, job);
  const assignments = await jobAssignments(ctx, job);
  const crew: CrewFact[] = [];
  for (const a of assignments) {
    const cleaner = await ctx.db.get(a.cleanerId);
    crew.push({ assignmentId: a._id, cleanerId: a.cleanerId, name: cleaner?.name ?? "A cleaner", role: a.role ?? null, status: a.status, checkInAt: a.checkIn?.at ?? null, lateReported: a.late !== undefined, submittedAt: a.completion?.submittedAt ?? null, incomplete: a.completion?.incomplete === true, note: a.completion?.note ?? null, payCents: a.payCents, offerKind: a.offerKind ?? null });
  }
  const reports = await ctx.db
    .query("jobReports")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(50);
  // Readiness evidence for this kind of work only: acknowledgments and documents the crew holds.
  const acknowledgments: JobFacts["acknowledgments"] = [];
  const definitions = new Map<string, string>();
  for (const a of assignments.filter((row) => row.status === "accepted")) {
    const rows = await ctx.db
      .query("workerRequirements")
      .withIndex("by_company_cleaner", (q) => q.eq("companyId", job.companyId).eq("cleanerId", a.cleanerId))
      .take(60);
    for (const row of rows) {
      if (!definitions.has(row.key)) {
        const def = await ctx.db
          .query("requirementDefinitions")
          .withIndex("by_company_key", (q) => q.eq("companyId", job.companyId).eq("key", row.key))
          .first();
        definitions.set(row.key, def?.label ?? row.key);
      }
      acknowledgments.push({ cleanerId: a.cleanerId, key: row.key, label: definitions.get(row.key)!, acknowledgedAt: row.acknowledged?.at ?? null, accepted: row.status === "accepted" });
    }
  }
  return {
    job,
    customer,
    property,
    scope: splitScope(job.scope),
    checklist: items.map((i) => ({ id: i._id, label: i.label, section: i.section ?? null, state: i.state, skipReason: i.skipReason ?? null, requiresPhoto: i.requiresPhoto, photos: photos.filter((p) => p.checklistItemId === i._id).length, at: i.at ?? null })),
    photos: photos.map((p) => ({ id: p._id, kind: p.kind, checklistItemId: p.checklistItemId ?? null, uploadedAt: p.uploadedAt, cleanerId: p.cleanerId })),
    crew,
    reports: reports.map((r) => ({ id: r._id, kind: r.kind, text: r.text, status: r.status, at: r.createdAt, cleanerId: r.cleanerId })),
    acknowledgments,
    ...(await visitFacts(ctx, job)),
    historical: await isHistorical(ctx, job),
  };
}

/** One string for the evidence as it stands, so unchanged evidence is never read (or billed) twice. */
export function evidenceStamp(facts: JobFacts, comms: number): string {
  const checklist = facts.checklist.map((c) => `${c.id}:${c.state}:${c.photos}`).join(",");
  const photos = facts.photos.length ? `${facts.photos.length}:${Math.max(...facts.photos.map((p) => p.uploadedAt))}` : "0";
  const crew = facts.crew.map((c) => `${c.assignmentId}:${c.status}:${c.submittedAt ?? 0}:${c.incomplete ? 1 : 0}`).join(",");
  const reports = facts.reports.map((r) => `${r.id}:${r.status}`).join(",");
  return [facts.job.status, facts.job.completionReportedAt ?? 0, facts.job.completionReturns ?? 0, checklist, photos, crew, reports, comms].join("|");
}

// ── Assembly for people ──────────────────────────────────────────────────────────────────────────

export async function assembleEvidence(ctx: Ctx, company: Doc<"companies">, job: Doc<"jobs">, viewer: Viewer, facts?: JobFacts): Promise<Assembled> {
  const f = facts ?? (await jobFacts(ctx, job));
  const tz = company.timezone;
  const jobSource = src("jobs", job._id, `${job.serviceSnapshot?.name ?? job.serviceType} on ${day(job.startsAt, tz)}`, job.startsAt);
  const owner = viewer.kind === "agent" || isOwner(viewer.role);
  const managerial = viewer.kind === "agent" || viewer.role === "owner" || viewer.role === "manager";

  // ── The service promise ──
  const promise: Section = { id: "promise", title: "What was promised", items: [], gaps: [] };
  promise.items.push({ label: "Service", detail: `${job.serviceSnapshot?.name ?? job.serviceType}${job.serviceSnapshot?.version ? `, service version ${job.serviceSnapshot.version}` : ""}. ${f.scope.included.length} listed ${f.scope.included.length === 1 ? "task" : "tasks"}${f.scope.excluded.length ? `; not included: ${f.scope.excluded.join(", ")}` : ""}.`, basis: "fact", at: job.startsAt, atKind: "scheduled", source: jobSource });
  if (!f.scope.included.length) promise.gaps.push({ state: "not_found", what: "The visit's scope lists no individual tasks, so there is nothing itemised to compare against.", source: jobSource });
  if (job.checklistTemplate) promise.items.push({ label: "Checklist version", detail: `Copied from checklist template version ${job.checklistTemplate.version}.`, basis: "fact", source: src("checklistTemplates", job.checklistTemplate.templateId, `Checklist v${job.checklistTemplate.version}`) });
  else if (!f.checklist.length) promise.gaps.push({ state: "not_found", what: "This visit has no checklist." });
  const quote = await ctx.db
    .query("serviceQuotes")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .first();
  if (quote) {
    const addOns = quote.lines.filter((l) => l.kind === "add_on").map((l) => l.label);
    promise.items.push({ label: "Accepted price breakdown", detail: addOns.length ? `Add-ons on the quote: ${addOns.join(", ")}.` : "No add-ons on the quote.", basis: "fact", source: src("serviceQuotes", quote._id, "Quote for this visit") });
  } else promise.gaps.push({ state: "not_found", what: "No quote is linked to this visit, so add-ons are read from the scope only." });
  const approvedAddOns = f.reports.filter((r) => r.kind === "addon_request" && r.status === "approved");
  for (const r of approvedAddOns) promise.items.push({ label: "Approved scope change", detail: `Added during the visit: "${r.text.slice(0, 200)}"`, basis: "fact", at: r.at, atKind: "recorded", source: src("jobReports", r.id, "Crew request") });
  if (f.property) {
    const notes = [f.property.accessInstructions && "access", f.property.crewNotes && "crew notes", f.property.clientNotes && "the customer's preferences", f.property.parking && "parking"].filter(Boolean);
    if (notes.length) promise.items.push({ label: "Property instructions", detail: `On record: ${notes.join(", ")}.`, basis: "fact", source: src("properties", f.property._id, f.property.label?.trim() || f.property.address.line1) });
    else promise.gaps.push({ state: "not_found", what: "The property has no access instructions, crew notes or preferences on record." });
  }
  if (job.instructions) promise.items.push({ label: "Visit instructions", detail: job.instructions.slice(0, 300), basis: "fact", source: jobSource });
  try {
    const terms = await serviceTerms({ ...(ctx as QueryCtx), company, role: "manager" }, { customerId: job.customerId, propertyId: job.propertyId });
    for (const a of terms.agreements) {
      const remedy = typeof a.terms.correctiveRemedy === "string" ? ` On corrections it says: ${String(a.terms.correctiveRemedy).slice(0, 200)}` : "";
      promise.items.push({ label: "Agreement", detail: `"${a.title}" governs this service.${remedy}`, basis: "fact", source: src("agreements", a.agreementId, a.title) });
    }
    if (!terms.agreements.length) promise.gaps.push({ state: "not_found", what: "No signed agreement governs this customer or property." });
  } catch {
    promise.gaps.push({ state: "no_access", what: "Agreements could not be read for this visit." });
  }

  // ── People and execution ──
  const execution: Section = { id: "execution", title: "Who did the work and what they recorded", items: [], gaps: [] };
  const accepted = f.crew.filter((c) => c.status === "accepted");
  for (const c of f.crew) {
    if (c.status !== "accepted" && c.offerKind !== "replacement" && c.status !== "cancelled") continue;
    const words = c.status === "accepted"
      ? `${c.name}${c.role ? ` (${c.role})` : ""}: ${c.checkInAt ? `checked in ${day(c.checkInAt, tz)} at ${clock(c.checkInAt, tz)}` : "no check-in recorded"}${c.lateReported ? ", reported running late" : ""}${c.submittedAt ? `, submitted ${c.incomplete ? "as incomplete" : "as done"}` : ", has not submitted"}.`
      : `${c.name} was on this visit and was taken off (${c.status}).`;
    execution.items.push({ label: c.status === "accepted" ? "Crew" : "Assignment history", detail: words, basis: "fact", at: c.checkInAt ?? undefined, atKind: c.checkInAt ? "occurred" : undefined, source: src("assignments", c.assignmentId, c.name) });
    if (c.status === "accepted" && c.incomplete && c.note) execution.items.push({ label: "Cleaner's note", detail: c.note.slice(0, 300), basis: "cleaner_stated", source: src("assignments", c.assignmentId, c.name) });
  }
  if (!accepted.length) execution.gaps.push({ state: "not_found", what: "No cleaner has an accepted assignment on this visit." });
  const done = f.checklist.filter((c) => c.state === "done").length;
  const skipped = f.checklist.filter((c) => c.state === "skipped");
  const pending = f.checklist.filter((c) => c.state === "pending");
  if (f.checklist.length) execution.items.push({ label: "Checklist", detail: `${done} done, ${skipped.length} skipped, ${pending.length} not marked, of ${f.checklist.length}.`, basis: "fact", source: jobSource });
  for (const s of skipped) execution.items.push({ label: "Skipped", detail: `"${s.label}"${s.skipReason ? `: ${s.skipReason}` : ", with no reason given"}.`, basis: "cleaner_stated", at: s.at ?? undefined, atKind: "recorded", source: src("checklistItems", s.id, s.label) });
  const byKind = (k: PhotoFact["kind"]) => f.photos.filter((p) => p.kind === k).length;
  execution.items.push({ label: "Photos", detail: f.photos.length ? `${byKind("before")} before, ${byKind("after")} after, ${byKind("item")} of checklist items, ${byKind("issue")} of issues. Times are when each reached Selestial; when they were taken is not recorded.` : "No photos were uploaded.", basis: "fact", source: jobSource });
  if (!f.photos.length) execution.gaps.push({ state: "not_found", what: "No photos are on this visit." });
  for (const r of f.reports) execution.items.push({ label: r.kind === "incomplete" ? "Reported incomplete" : r.kind === "addon_request" ? "Asked to add to the scope" : "Condition reported", detail: `"${r.text.slice(0, 240)}" (${r.status.replace(/_/g, " ")})`, basis: "cleaner_stated", at: r.at, atKind: "recorded", source: src("jobReports", r.id, "Crew report") });
  if (job.completionReview) execution.items.push({ label: "Manager's decision", detail: job.completionReview.decision === "closed" ? "A manager reviewed the crew's report and closed the visit." : "The visit was closed without a review.", basis: "fact", at: job.completionReview.at, atKind: "recorded", source: jobSource });
  if ((job.completionReturns ?? 0) > 0) execution.items.push({ label: "Sent back", detail: `The report was sent back for correction ${job.completionReturns} ${job.completionReturns === 1 ? "time" : "times"}.`, basis: "fact", source: jobSource });
  if (managerial) {
    for (const a of f.acknowledgments) if (a.acknowledgedAt) execution.items.push({ label: "Readiness", detail: `${f.crew.find((c) => c.cleanerId === a.cleanerId)?.name ?? "A cleaner"} acknowledged "${a.label}".`, basis: "fact", at: a.acknowledgedAt, atKind: "recorded" });
  }
  const coverage = await ctx.db
    .query("coverageRequests")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(10);
  for (const c of coverage) execution.items.push({ label: "Replacement", detail: `A slot opened (${c.cause.replace(/_/g, " ")}) and was ${c.status === "filled" ? "filled" : c.status.replace(/_/g, " ")}.`, basis: "fact", at: c.openedAt, atKind: "occurred", source: src("coverageRequests", c._id, "Coverage") });

  // ── Communications ──
  const communications: Section = { id: "communications", title: "Calls, texts and email", items: [], gaps: [] };
  const from = job.startsAt - 3 * DAY;
  const until = Math.max(job.endsAt + 14 * DAY, Date.now());
  const outbound = await ctx.db
    .query("messages")
    .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
    .take(100);
  for (const m of outbound.filter((m) => m.purpose !== "member_notice")) communications.items.push({ label: m.cleanerId ? "To the crew" : "To the customer", detail: `${m.purpose.replace(/_/g, " ")} by ${m.channel === "email" ? "email" : "text"}: ${m.status.replace(/_/g, " ")}.`, basis: "fact", at: m.sentAt ?? m.queuedAt, atKind: m.sentAt ? "occurred" : "recorded", source: src("messages", m._id, "Message") });
  const inbound = (
    await ctx.db
      .query("inboundMessages")
      .withIndex("by_company_customer", (q) => q.eq("companyId", job.companyId).eq("customerId", job.customerId).gte("receivedAt", from))
      .take(100)
  ).filter((m) => m.receivedAt <= until && m.kind === "message");
  for (const m of inbound) communications.items.push({ label: "From the customer", detail: `A ${m.channel === "email" ? "email" : "text"} (only a short excerpt is kept): "${m.body.slice(0, 200)}"`, basis: "customer_stated", at: m.receivedAt, atKind: "received", source: src("inboundMessages", m._id, "Customer message", m.receivedAt) });
  const opportunities = job.customerId
    ? await ctx.db
        .query("salesOpportunities")
        .withIndex("by_company_customer", (q) => q.eq("companyId", job.companyId).eq("customerId", job.customerId))
        .take(10)
    : [];
  let salesCount = 0;
  for (const o of opportunities) {
    const rows = await ctx.db
      .query("salesMessages")
      .withIndex("by_company_opportunity", (q) => q.eq("companyId", job.companyId).eq("opportunityId", o._id).gte("at", job.startsAt - 60 * DAY))
      .take(60);
    for (const m of rows) {
      if (m.direction === "note" || m.at > until) continue;
      salesCount += 1;
      if (salesCount <= 12) communications.items.push({ label: m.direction === "in" ? "Customer, in the Sales conversation" : "Company, in the Sales conversation", detail: `"${m.body.slice(0, 200)}"`, basis: m.direction === "in" ? "customer_stated" : "fact", at: m.at, atKind: "occurred", source: src("salesMessages", m._id, "Sales conversation", m.at) });
    }
  }
  const cleanerIds = new Set(f.crew.map((c) => c.cleanerId as string));
  const readings = (
    await ctx.db
      .query("replyReadings")
      .withIndex("by_company_received", (q) => q.eq("companyId", job.companyId).gte("receivedAt", from))
      .take(200)
  ).filter((r) => cleanerIds.has(r.cleanerId) && r.receivedAt <= until && (r.assignmentId === undefined || f.crew.some((c) => c.assignmentId === r.assignmentId)));
  for (const r of readings) communications.items.push({ label: "From the crew", detail: `A text (only an excerpt is kept): "${r.excerpt.slice(0, 200)}"`, basis: "cleaner_stated", at: r.receivedAt, atKind: "received", source: src("replyReadings", r._id, "Cleaner text", r.receivedAt) });
  if (!inbound.length && !readings.length && !salesCount) communications.gaps.push({ state: "not_found", what: "No texts from the customer or crew near this visit are on record in Selestial." });
  // Calls: only from a connected phone platform the Owner allowed Quality to read.
  const settings = qualitySettings(company);
  const connection = await ctx.db
    .query("qualityConnections")
    .withIndex("by_company_provider", (q) => q.eq("companyId", job.companyId).eq("provider", "quo"))
    .first();
  if (!connection || connection.status === "disconnected") communications.gaps.push({ state: "not_connected", what: "No phone platform is connected, so calls and their transcripts cannot be read. This is not the same as there being no calls." });
  else if (!settings.readPhonePlatform) communications.gaps.push({ state: "no_access", what: "A phone platform is connected, but reading it for quality evidence is switched off in Quality's Playbook." });
  else {
    if (connection.status !== "connected") communications.gaps.push({ state: "no_access", what: `The phone platform connection needs attention (${connection.problem ?? connection.status}). Calls after its last good read may be missing.` });
    const linked = await ctx.db
      .query("qualityComms")
      .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
      .take(100);
    for (const c of linked) {
      const label = c.kind === "call" ? (c.direction === "incoming" ? "Call in" : "Call out") : c.kind === "voicemail" ? "Voicemail" : c.direction === "incoming" ? "Text in (phone platform)" : "Text out (phone platform)";
      const transcript = c.transcript?.status === "completed" ? `transcript of ${c.transcript.segments.length} segments (version ${c.transcript.version})` : c.kind === "call" ? `transcript ${c.transcript?.status.replace(/_/g, " ") ?? "not checked yet"}` : "";
      communications.items.push({ label, detail: `${c.durationSec ? `${Math.round(c.durationSec / 60)} min` : ""}${transcript ? ` · ${transcript}` : ""}${c.body ? ` "${c.body.slice(0, 160)}"` : ""}${c.unavailableAt ? " · no longer available at the provider" : ""}`.trim(), basis: "fact", at: c.occurredAt, atKind: "occurred", source: src("qualityComms", c._id, label, c.occurredAt) });
      if (c.kind === "call" && (c.transcript?.status === "in_progress" || c.transcript === undefined)) communications.gaps.push({ state: "processing", what: "A call's transcript is still being prepared by the provider. It is checked again.", source: src("qualityComms", c._id, label) });
      if (c.transcript?.revisedAt) {
        const stale = await ctx.db
          .query("qualityExtracts")
          .withIndex("by_company_comm", (q) => q.eq("companyId", job.companyId).eq("commId", c._id))
          .take(50);
        if (stale.some((e) => e.state === "stale")) communications.gaps.push({ state: "stale", what: "The provider revised a transcript after it was read; earlier readings are marked stale.", source: src("qualityComms", c._id, label) });
      }
    }
    if (f.customer?.phone) {
      const pending = await ctx.db
        .query("qualityAssociations")
        .withIndex("by_company_status", (q) => q.eq("companyId", job.companyId).eq("status", "needs_review"))
        .take(100);
      const here = pending.filter((a) => a.candidates.some((c) => c.jobId === job._id));
      for (const a of here) communications.gaps.push({ state: "needs_association", what: `A conversation might be about this visit or another one. A person decides: ${a.why}`, source: src("qualityAssociations", a._id, "Association review") });
    }
    if (!linked.length) communications.gaps.push({ state: "not_found", what: `No calls or platform texts are linked to this visit${connection.lastSuccessAt ? ` (last read ${day(connection.lastSuccessAt, tz)})` : ""}.` });
  }
  communications.gaps.push({ state: "no_access", what: "Email to the company's own mailbox is not read for quality evidence. Sales replies and Care & Retention inbox replies reach Selestial only where those are connected." });

  // ── Money ──
  const financial: Section = { id: "financial", title: "Price, payment and cost", items: [], gaps: [] };
  if (!owner) financial.gaps.push({ state: "restricted", what: "Prices, payments, credits and crew pay are shown to the Owner only." });
  else {
    financial.items.push({ label: "Price", detail: job.priceCents === undefined ? "No price on the visit." : job.recovery ? "A correction visit: not charged to the customer. Its price is the crew's pay basis." : `$${(job.priceCents / 100).toFixed(2)} from the company's pricing (a price, not a payment).`, basis: "fact", source: jobSource });
    const invoices = await ctx.db
      .query("invoices")
      .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
      .take(5);
    for (const inv of invoices) financial.items.push({ label: "Invoice", detail: `${inv.number ?? "Invoice"}: ${inv.status}, balance $${(inv.totals.balanceCents / 100).toFixed(2)}${inv.totals.creditedCents ? `, credited $${(inv.totals.creditedCents / 100).toFixed(2)}` : ""}.`, basis: "fact", source: src("invoices", inv._id, inv.number ?? "Invoice") });
    if (!invoices.length && !job.recovery) financial.gaps.push({ state: "not_found", what: "No invoice is linked to this visit." });
    const pay = accepted.reduce((sum, c) => sum + c.payCents, 0);
    if (accepted.length) financial.items.push({ label: "Crew pay", detail: `$${(pay / 100).toFixed(2)} across ${accepted.length} ${accepted.length === 1 ? "cleaner" : "cleaners"}, as offered.`, basis: "fact" });
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_company_job", (q) => q.eq("companyId", job.companyId).eq("jobId", job._id))
      .take(20);
    const spent = expenses.filter((e) => e.status === "recorded" && !e.voided).reduce((s, e) => s + (e.amountCents ?? 0), 0);
    if (spent) financial.items.push({ label: "Expenses", detail: `$${(spent / 100).toFixed(2)} recorded against this visit.`, basis: "fact" });
  }

  // ── History ──
  const history: Section = { id: "history", title: "Earlier at this property", items: [], gaps: [] };
  const earlier = await ctx.db
    .query("jobs")
    .withIndex("by_company_property_start", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId).lt("startsAt", job.startsAt))
    .order("desc")
    .take(6);
  for (const e of earlier.filter((j) => j.status === "completed").slice(0, 3)) history.items.push({ label: "Earlier visit", detail: `${e.serviceSnapshot?.name ?? e.serviceType} on ${day(e.startsAt, tz)}${e.recovery ? " (a correction)" : ""}.`, basis: "fact", at: e.startsAt, atKind: "scheduled", source: src("jobs", e._id, "Earlier visit", e.startsAt) });
  const priorCases = await ctx.db
    .query("qualityCases")
    .withIndex("by_company_property", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId))
    .order("desc")
    .take(20);
  for (const c of priorCases) {
    if (c.jobId === job._id || (c.restricted && !owner)) continue;
    const reviewed = await ctx.db
      .query("qualityFindings")
      .withIndex("by_company_case", (q) => q.eq("companyId", job.companyId).eq("caseId", c._id))
      .take(20);
    const verified = reviewed.filter((x) => x.state === "reviewed");
    history.items.push({ label: c.stage === "closed" ? "Earlier quality case" : "Open quality case here", detail: `${c.title}${verified.length ? `: ${verified.length} reviewed ${verified.length === 1 ? "finding" : "findings"}` : ": no reviewed findings"}.`, basis: "fact", at: c.createdAt, atKind: "recorded", source: src("qualityCases", c._id, "Quality case", c.createdAt) });
  }
  const retention = await ctx.db
    .query("retentionCases")
    .withIndex("by_company_property", (q) => q.eq("companyId", job.companyId).eq("propertyId", job.propertyId))
    .order("desc")
    .take(10);
  for (const r of retention.filter((r) => r.kind === "recovery" && r.jobId !== job._id).slice(0, 3)) history.items.push({ label: "Earlier recovery", detail: `${r.title}${r.outcome ? ` · ${r.outcome.code.replace(/_/g, " ")}` : " · still open"}.`, basis: "fact", at: r.createdAt, atKind: "recorded", source: src("retentionCases", r._id, "Retention case", r.createdAt) });
  if (f.historical) history.items.push({ label: "Imported", detail: "This visit was brought in from another system. It is reviewed for the record; nobody is contacted about it.", basis: "fact" });
  if (!earlier.length) history.gaps.push({ state: "not_found", what: "No earlier visits at this property are on record in Selestial." });

  const commsCount = communications.items.length;
  return { facts: f, sections: [promise, execution, communications, financial, history], stamp: evidenceStamp(f, commsCount) };
}

export const HOURS = HOUR;
