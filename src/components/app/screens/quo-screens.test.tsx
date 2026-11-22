import { writeFileSync } from "node:fs";

import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CompanyProvider } from "@/components/app/company";

const data: Record<string, unknown> = {};
vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => (args === "skip" ? undefined : data[getFunctionName(ref)]),
  useMutation: () => async () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox", useRouter: () => ({ replace: () => undefined, push: () => undefined }), useSearchParams: () => new URLSearchParams("") }));

const { QuoSetupScreen } = await import("./quo-setup");
const { ConversationsScreen } = await import("./inbox");

const T = Date.UTC(2026, 10, 22, 15, 0);
const html = (node: React.ReactNode) => renderToStaticMarkup(<CompanyProvider company={{ companyId: "c" as never, name: "Alpha Cleaning", timezone: "America/Chicago", role: "owner" }}>{node}</CompanyProvider>);
function keep(name: string, markup: string) {
  const out = process.env.VISUAL_OUT;
  if (out) writeFileSync(`${out}/${name}.html`, markup);
}

const readiness = {
  steps: [
    { key: "key", label: "API key accepted by Quo", done: true, detail: "Key ending 6789." },
    { key: "numbers", label: "Numbers chosen", done: true, detail: "+15125550100" },
    { key: "webhook", label: "Replies and delivery updates come to Selestial", done: true, detail: "Quo sends replies and delivery updates for the chosen numbers to Selestial." },
    { key: "registration", label: "Carrier registration", done: true, detail: "Quo shows the registration as approved." },
    { key: "test", label: "Test text and reply", done: false, detail: "Reply to the test text from your phone." },
    { key: "agents", label: "Agents allowed", done: true, detail: "Dispatch" },
  ],
  agents: [
    { agent: "dispatch", state: "blocked", words: "Automatic replies stay paused until the reply test is complete.", workflow: { audience: "Cleaners on your team, about their own visits", sender: "+15125550100 (new conversations; existing ones keep their number)", trigger: "A visit needs a cleaner, is confirmed, or is about to start", approval: "Propose: it drafts each text for your approval", behavior: "Texts job offers, confirmations and reminders." } },
    { agent: "sales", state: "blocked", words: "Sales follow-up needs approved messaging consent: publish your texting sign-up wording first.", workflow: { audience: "People who asked about service", sender: "+15125550100", trigger: "A new inquiry", approval: "Act: it sends on its own within your rules", behavior: "Answers questions." } },
  ],
  limitations: ["Quo shows carrier registration for the whole workspace, not for each number."],
};

describe("Quo and Inbox screens", () => {
  it("the Quo setup shows its state, each step, what each agent can do, the workflow before it's allowed, and the limits", () => {
    data["quo:connection"] = { state: "setup_incomplete", canManage: true, keyHint: "…6789", keySetAt: T, checkedAt: T, available: [{ id: "PN1", phoneNumber: "+15125550100", name: "Main line", usMessaging: "unrestricted" }, { id: "PN2", phoneNumber: "+15125550200", name: "Hiring", usMessaging: "restricted" }], selected: [{ id: "PN1", phoneNumber: "+15125550100", name: "Main line" }], useForNew: true, registration: { status: "approved", checkedAt: T, confirmedByOwner: false }, webhook: { since: T, lastEventAt: null }, test: { to: "+15125559999", sentAt: T, sent: true, problem: null, replyAt: null }, replyVerifiedAt: null, agents: ["dispatch"], problem: null, errors: [{ at: T, words: "Quo asked Selestial to slow down." }], disconnectedAt: null, readiness };
    const page = html(<QuoSetupScreen />);
    keep("quo-setup", page);
    for (const text of ["Setup incomplete", "Test text and reply", "Sent to +15125559999. Reply to it from your phone.", "Automatic replies stay paused until the reply test is complete.", "Sales follow-up needs approved messaging consent", "Who it texts", "Propose: it drafts each text for your approval", "Quo restricts US texting on this number", "Use +15125550100 for new conversations", "Replace the key", "Disconnect…", "Powered by Quo (formerly OpenPhone)"]) expect(page, text).toContain(text);
    expect(page).not.toContain("quo_test_key");

    data["quo:connection"] = { state: "not_connected", canManage: true, readiness: { ...readiness, steps: readiness.steps.map((s) => ({ ...s, done: false })) } };
    const fresh = html(<QuoSetupScreen />);
    keep("quo-connect", fresh);
    for (const text of ["Not connected", "Workspace Settings › API", "approved carrier registration", "Connect Quo"]) expect(fresh, text).toContain(text);
  });

  it("the Inbox shows each conversation's provider, sender and owner, keeps delivery apart from the outcome, and offers takeover", () => {
    data["smsConversations:list"] = [
      { conversationId: "s1", address: "+15125557777", people: [{ kind: "cleaner", name: "Rosa" }], provider: "quo", sender: "+15125550100", owner: "external", ownerWords: "Someone in the Quo app", agentsPaused: false, lastInboundAt: T, lastOutboundAt: T, blocked: null },
      { conversationId: "s2", address: "+15125553333", people: [], provider: "native", sender: "+15125551000", owner: "review", ownerWords: "Review queue", agentsPaused: true, lastInboundAt: T, lastOutboundAt: null, blocked: null },
    ];
    data["members:list"] = [{ id: "m1", name: "Owner A", email: "a@example.test", role: "owner", status: "active" }];
    data["smsConversations:thread"] = {
      conversationId: "s1",
      address: "+15125557777",
      provider: "quo",
      sender: "+15125550100",
      owner: { kind: "external" },
      ownerWords: "Someone in the Quo app",
      ownerReason: "Someone answered from the Quo app, so agents stepped back until a person returns the conversation to them.",
      ownerChangedAt: T,
      agentsPaused: false,
      people: [{ kind: "cleaner", id: "c1", name: "Rosa" }],
      openTasks: [],
      connection: { status: "ready", problem: null },
      items: [
        { id: "a", direction: "outgoing", at: T, body: "New job Tuesday 9am. Tap to accept.", provider: "quo", by: "Dispatch agent", status: "delivered", statusWords: "Delivered to the phone", problem: null, purpose: "offer", outcome: "Cleaner accepted the job" },
        { id: "b", direction: "incoming", at: T + 60_000, body: "Can I start at 10?", provider: "quo", by: null, status: null, statusWords: null, problem: null, purpose: null, outcome: null },
      ],
      me: "m1",
    };
    const page = html(<ConversationsScreen />);
    keep("inbox", page);
    for (const text of ["Answered in Quo", "Needs review", "Agent replies paused", "Answered by: Someone in the Quo app", "Take over conversation", "Return to agent", "Assign to", "Delivered to the phone", "Outcome: Cleaner accepted the job", "via Quo from +15125550100", "Can I start at 10?"]) expect(page, text).toContain(text);
  });
});
