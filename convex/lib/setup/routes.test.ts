import { describe, expect, it } from "vitest";

import { allowedDuringSetup, isSetupPage, safeSetupPath, setupDestination } from "./routes";

describe("Where an Owner may go during setup", () => {
  it("allows the pages setup sends them to, including where OAuth returns, and nothing else", () => {
    for (const path of ["/app/setup", "/app/setup/business", "/app/settings/integrations", "/app/settings/integrations/quo", "/app/integrations", "/app/agents/recruiter/applicants", "/app/cleaners/import", "/app/migration", "/app/migration/review", "/app/services/abc123", "/app/agents/sales/booking-forms/xyz", "/app/approvals", "/app/settings/billing", "/app/texting", "/app/schedule"]) {
      expect(allowedDuringSetup(path), path).toBe(true);
    }
    for (const path of ["/app", "/app/chat", "/app/settings", "/app/settings/people", "/app/agents/sales", "/app/cleaners/abc", "/app/approvalsx", "/app/setupx", "/app/schedule/abc"]) {
      expect(allowedDuringSetup(path), path).toBe(false);
    }
    expect(isSetupPage("/app/setup?step=build")).toBe(true);
    expect(setupDestination("/app/settings/integrations?result=failed")).toBe("integration");
    expect(setupDestination("/app/agents/recruiter/applicants/")).toBe("inbox");
  });

  it("follows only same-site paths setup allows, so a return address can never redirect elsewhere", () => {
    expect(safeSetupPath("/app/settings/integrations?tool=gmail&result=confirm")).toBe("/app/settings/integrations?tool=gmail&result=confirm");
    expect(safeSetupPath("/app/setup?step=context")).toBe("/app/setup?step=context");
    for (const raw of ["https://evil.example/app/setup", "//evil.example/app/setup", "/\\evil.example", "/app/../evil", "/%2F%2Fevil.example", "javascript:alert(1)", "/app/chat", "", null, undefined, "/app/setup\u0000", "/app/setup?next=<script>"]) {
      expect(safeSetupPath(raw as string), String(raw)).toBe(raw === "/app/setup?next=<script>" ? "/app/setup" : null);
    }
  });
});
