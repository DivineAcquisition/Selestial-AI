/**
 * The texting case's screens, rendered with fixed data: Evidence & notes for the owner and inside a support
 * session, recommendation actions, and the staff readiness panel. The server decides what each viewer
 * receives; these check that the screens say what they mean (internal review is never carrier approval).
 */
import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompanyProvider } from "@/components/app/company";

import type { Id } from "../../../../convex/_generated/dataModel";
import { caseFixture, readinessFixture } from "./case.fixtures";

let data: Record<string, unknown> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : data[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
  useConvex: () => ({ query: async () => undefined }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/texting", useRouter: () => ({ push: () => undefined, replace: () => undefined }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/components/app/texting/context", () => ({ useSetup: () => ({ companyId: "company1", go: async () => undefined }) }));

const { EvidenceNotes } = await import("@/components/app/texting/evidence");
const { Recommendations } = await import("@/components/app/texting/recommendations");
const { TextingReadiness } = await import("@/components/staff/texting-case");

const companyId = "company1" as Id<"companies">;
const render = (node: React.ReactNode) => renderToStaticMarkup(<CompanyProvider company={{ companyId, name: "Alpha Cleaning", timezone: "America/Chicago", role: "owner" }}>{node}</CompanyProvider>);

describe("Texting case screens", () => {
  beforeEach(() => {
    data = {};
  });

  it("shows the owner their evidence with internal review named as Selestial's, and what is blocked and can continue", () => {
    data["textingCase:workspace"] = caseFixture("owner");
    const html = render(<EvidenceNotes companyId={companyId} context="permission" />);
    expect(html).toContain("Evidence &amp; notes");
    expect(html).toContain("it is not the carriers&#x27; decision");
    expect(html).toContain("Accepted for Selestial review");
    expect(html).toContain("Filed with submission 1");
    expect(html).toContain("1 earlier version kept");
    expect(html).toContain("You can keep going:");
    expect(html).toContain("Add a redacted review copy");
    expect(html).not.toContain("Selestial only");
    expect(html).not.toContain("Support session");
  });

  it("marks internal items and the session in a support session, and opens files only after content is revealed", () => {
    data["textingCase:workspace"] = caseFixture("support");
    const html = render(<EvidenceNotes companyId={companyId} context="review" />);
    expect(html).toContain("Support session · Manage");
    expect(html).toContain("Internal · Selestial only");
    expect(html).toContain("Reveal content to open files.");
    expect(html).toContain("Internal: the company never sees it");
    // Owner-only actions are not offered to staff.
    expect(html).not.toContain("Add a redacted review copy");
    expect(html).not.toContain("Send answer");
  });

  it("gives each recommendation its responsible party, basis, effect, approval and actions, and never promises approval", () => {
    data["textingCase:workspace"] = caseFixture("owner");
    const html = render(<Recommendations step="permission" />);
    expect(html).toContain("Retention agent");
    expect(html).toContain("Apply draft change");
    expect(html).toContain("Edit suggestion");
    expect(html).toContain("Request clarification");
    expect(html).toContain("Dismiss");
    expect(html).toContain("Approve action");
    expect(html).toContain("Needs your approval");
    expect(html).toContain("doesn&#x27;t guarantee the carriers&#x27; approval");
    expect(html).toContain("Details changed");
  });

  it("shows readiness only as configured, not configured, failed or not verified", () => {
    data["textingReview:readiness"] = readinessFixture;
    const html = render(<TextingReadiness />);
    for (const label of ["Configured", "Not configured", "Failed", "Not verified"]) expect(html).toContain(label);
    expect(html).toContain("files nothing, not even a mock");
  });
});
