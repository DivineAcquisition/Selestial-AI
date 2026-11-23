/**
 * Quality's screens rendered over what the real queries returned for a sample company
 * (tests/fixtures/qualityScreens.json, written by convex/qualityScreens.test.ts with QUALITY_SCREENS_OUT).
 * Each screen must say what was checked, what was found and what happens next in words, never show a score
 * or a confidence figure, and keep the customer's answer apart from Quality's verification.
 *
 * With VISUAL_OUT set, each screen is also written as HTML there, to be looked at with the built styles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CompanyProvider } from "@/components/app/company";

type Sample = Record<string, unknown> & { reviews: { job: { startsAt: number } }[] };
const sample = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../tests/fixtures/qualityScreens.json"), "utf8")) as Sample;
const NOW = Math.max(...sample.reviews.map((r) => r.job.startsAt)) + 4 * 3_600_000;

const answers: Record<string, unknown> = {
  "quality:overview": sample.overview,
  "quality:reviews": sample.reviews,
  "quality:review": sample.review,
  "quality:cases": sample.cases,
  "quality:caseDetail": sample.caseDetail,
  "quality:corrections": sample.corrections,
  "quality:standards": sample.standards,
  "quality:standard": sample.standard,
  "quality:insights": sample.insights,
  "quality:playbook": sample.playbook,
  "quality:forJob": sample.forJob,
  "qualityComms:associations": sample.associations,
  "permissions:list": sample.permissions,
  "qualityLinks:view": sample.linkView,
  "quality:cleanerRates": sample.cleanerRates,
};
const search = "";
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : answers[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/agents/quality", useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams(search) }));
vi.mock("@/components/app/use-now", () => ({ useNow: () => NOW }));

const { QualityOverviewScreen } = await import("./overview");
const { QualityReviewsScreen, ReviewBody } = await import("./reviews");
const { QualityCasesScreen } = await import("./cases");
const { QualityCorrectionsScreen } = await import("./corrections");
const { QualityStandardsScreen } = await import("./standards");
const { QualityInsightsScreen } = await import("./insights");
const { QualityPlaybookScreen } = await import("./playbook");
const { QualityOnJob } = await import("./context");
const { CaseBody } = await import("./case-workspace");
const { QualityRequestPage } = await import("@/components/public/quality-page");

const html = (node: React.ReactNode, role: "owner" | "manager" | "office" = "owner") =>
  renderToStaticMarkup(<CompanyProvider company={{ companyId: "c" as never, name: "Brightside Cleaning Co.", timezone: "America/Chicago", role }}>{node}</CompanyProvider>);

function keep(name: string, markup: string) {
  const out = process.env.VISUAL_OUT;
  if (out) writeFileSync(`${out}/${name}.html`, markup);
}

/** Nothing on a Quality screen is a score, a rating of a person, or a made-up certainty. */
function noScores(page: string) {
  // The visit pass rate is the one figure the Owner asked for; it is labelled as such and never a score.
  const visible = page.replace(/<span[^>]*data-pass-rate[^>]*>.*?<\/span>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  // "keeps no score" says there is none; any other score, confidence figure or percentage is a failure.
  expect(visible).not.toMatch(/(?<!no )\bscore\b|confidence|\d+\s?%/i);
}

describe("Quality's screens", () => {
  it("the overview says what Quality checked, what it found and what happens next, from real runs", () => {
    const page = html(<QualityOverviewScreen />);
    keep("overview", page);
    for (const text of ["Quality", "Needs attention", "Dana Whitfield: oven", "A serious concern"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("reviews list every completed visit with its record, and a missing photo is waiting on evidence, not a failure", () => {
    const page = html(<QualityReviewsScreen />);
    keep("reviews", page);
    for (const text of ["Waiting on evidence", "Reviewed", "Case opened"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("a review opens with each requirement, where it came from, and that a complete record is not proof", () => {
    const page = html(<ReviewBody reviewId={(sample.review as { id: string }).id as never} />);
    keep("review-open", page);
    expect(page).toContain("A complete record is not proof of how the service looked");
    noScores(page);
  });

  it("cases show what was reported, what Quality is doing and what needs a person, and restricted cases stay restricted", () => {
    const page = html(<QualityCasesScreen />);
    keep("cases", page);
    for (const text of ["Reported", "Quality is", "Needs you", "Serious: Owner only"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("a case opens on its summary with findings marked as suggested until a person reviews them", () => {
    const page = html(<CaseBody caseId={(sample.caseDetail as { id: string }).id as never} />);
    keep("case-open", page);
    for (const text of ["Summary", "Evidence", "Timeline", "People", "Actions", "Outcome"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("corrections keep Quality's verification and the customer's answer apart", () => {
    const page = html(<QualityCorrectionsScreen />);
    keep("corrections", page);
    for (const text of ["Scheduled", "Customer not asked", "Quality verified", "Acceptance:"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("standards show the order they combine in, versions, and templates as starting points", () => {
    const page = html(<QualityStandardsScreen />);
    keep("standards", page);
    for (const text of ["How standards combine", "Company default", "Version history", "Residential, recurring"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("insights are counts with denominators and say when the sample is too small", () => {
    const page = html(<QualityInsightsScreen />);
    keep("insights", page);
    for (const text of ["too few to read trends", "Visits reviewed", "Documentation, not how the service looked", "Cleaners: visit pass rate", "too few to read a rate"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("the playbook shows each source's capabilities as checked, and recordings and sending through Quo are never used", () => {
    const page = html(<QualityPlaybookScreen />);
    keep("playbook", page);
    for (const text of ["Where evidence comes from", "Quo (formerly OpenPhone)", "same Quo connection your agents text through", "HighLevel", "Not available yet", "Recordings", "Not used", "Conversations to link", "Link to this visit", "Always a person"]) expect(page, text).toContain(text);
    noScores(page);
  });

  it("a visit's page shows its review and lets a manager report a concern", () => {
    const page = html(<QualityOnJob jobId={"j" as never} completed />);
    expect(page).toContain("Report a concern to Quality");
    expect(html(<QualityOnJob jobId={"j" as never} completed />, "office")).not.toContain("Report a concern to Quality");
  });

  it("the cleaner's private page asks only for the photos, names the visit by day and town, and repeats nothing anyone said", () => {
    const page = renderToStaticMarkup(<QualityRequestPage token="t" />);
    keep("cleaner-request", page);
    for (const text of ["A few photos from your visit", "This page is private to you", "Photos asked for", "Add photos", "When it was taken is not recorded"]) expect(page, text).toContain(text);
    expect(page).not.toMatch(/oven|frame|broken|complain/i);
  });
});
