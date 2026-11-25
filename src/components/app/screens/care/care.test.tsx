/**
 * Care's screens rendered over what the real queries returned for a sample company
 * (tests/fixtures/careScreens.json, written by convex/careScreens.test.ts with CARE_SCREENS_OUT). Each screen
 * must say who a request waits on and what happens next, keep a change apart from the message about it, show
 * delivery as the provider reported it, and claim no savings or productivity.
 *
 * With VISUAL_OUT set, each screen is also written as HTML there, to be looked at with the built styles.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CompanyProvider } from "@/components/app/company";

type Sample = { now: number; overview: unknown; list: unknown; followUps: unknown; setup: unknown; details: Record<string, unknown> };
const sample = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../tests/fixtures/careScreens.json"), "utf8")) as Sample;
let detail: unknown = sample.details.reschedule;
let search = "";

const answers = (): Record<string, unknown> => ({
  "clientCare:overview": sample.overview,
  "clientCare:list": sample.list,
  "clientCare:followUps": sample.followUps,
  "clientCare:setup": sample.setup,
  "clientCare:detail": detail,
});
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : answers()[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/agents/customer-care", useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams(search) }));
vi.mock("@/components/app/use-now", () => ({ useNow: () => sample.now }));

const { CareOverviewScreen } = await import("./overview");
const { CareRequestsScreen } = await import("./requests");
const { CareFollowUpsScreen } = await import("./follow-ups");
const { CareSetupScreen } = await import("./setup");
const { RequestWorkspaceBody } = await import("./request-workspace");

const html = (node: React.ReactNode, role: "owner" | "manager" | "office" = "owner") =>
  renderToStaticMarkup(<CompanyProvider company={{ companyId: "c" as never, name: "Alpha Cleaning", timezone: "America/Chicago", role }}>{node}</CompanyProvider>);

function keep(name: string, markup: string) {
  const out = process.env.VISUAL_OUT;
  if (out) writeFileSync(`${out}/${name}.html`, markup);
}

const text = (page: string) => page.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
function honest(page: string) {
  expect(text(page)).not.toMatch(/hours? saved|time saved|saved you|\d+% (?:faster|fewer)|confidence/i);
}

describe("Care screens", () => {
  it("briefs from the record: what came in, what is with you, what is due and what Care did", () => {
    const page = html(<CareOverviewScreen />);
    keep("01-overview", page);
    const words = text(page);
    for (const line of ["Care", "Waiting on you", "Urgent", "Lee Chen", "Promised updates due", "Steps that didn't go through", "What Care has been doing", "Pause Care"]) expect(words, line).toContain(line);
    expect(words).toContain("Your company's rules read each message. No AI credits are used.");
    honest(page);
  });

  it("lists requests with who has each, what happens next and when the client last heard", () => {
    const page = html(<CareRequestsScreen />);
    keep("02-requests", page);
    const words = text(page);
    for (const line of ["Marcus Reed", "Rescheduling", "Waiting for you", "Sam Okafor", "Waiting for client", "Jo Alvarez", "Priya Nair", "Search"]) expect(words, line).toContain(line);
    honest(page);
  });

  it("opens a request beside its conversation, keeping the change apart from the message about it", () => {
    detail = sample.details.partial;
    const partial = html(<RequestWorkspaceBody requestId={"r" as never} />);
    keep("03-request-partial", partial);
    const words = text(partial);
    expect(words).toContain("Conversation");
    expect(words).toContain("What Care found");
    expect(words).toContain("Change: Done");
    expect(words).toContain("Client message: Didn't happen");
    expect(words).toContain("Retry the message");
    detail = sample.details.reschedule;
    const pending = html(<RequestWorkspaceBody requestId={"r" as never} />);
    keep("04-request-approval", pending);
    expect(text(pending)).toContain("Decide in Approvals");
    expect(text(pending)).toContain("Change notice: 24 hours");
    detail = sample.details.answered;
    const answered = html(<RequestWorkspaceBody requestId={"r" as never} />);
    expect(text(answered)).toContain("Delivery confirmed");
    expect(text(answered)).toContain("Resolved");
    honest(partial + pending + answered);
  });

  it("shows each follow-up's waiting party, promise, next step and whether it runs on its own", () => {
    const page = html(<CareFollowUpsScreen />);
    keep("05-follow-ups", page);
    const words = text(page);
    for (const line of ["Waiting for", "Next", "Waiting for approval", "One reminder to the client"]) expect(words, line).toContain(line);
    honest(page);
  });

  it("sets up Care from shared settings, with authority per action and nothing editable for others", () => {
    const owner = html(<CareSetupScreen />);
    keep("06-care-setup", owner);
    const words = text(owner);
    for (const line of ["Channels", "Request types", "Change policy", "What Care may do", "Act automatically", "Ask me first", "Escalation contacts", "Operating hours", "Save Care Setup"]) expect(words, line).toContain(line);
    expect(words).toContain("Care doesn't change a visit's price yet");
    honest(owner);
  });

  it("opens Requests on the filter in its address", () => {
    search = "status=waiting_owner";
    const page = text(html(<CareRequestsScreen />));
    expect(page).toContain("Waiting for you");
    search = "";
  });
});
