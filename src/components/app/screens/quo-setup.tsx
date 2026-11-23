"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextInput, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { CheckCircle2, CircleDashed } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";

type View = NonNullable<ReturnType<typeof useQuery<typeof api.quo.connection>>>;
type Connected = Exclude<View, { state: "not_connected" }>;

const STATE: Record<View["state"], { label: string; variant: "outline" | "info" | "success" | "warning" | "error" }> = {
  not_connected: { label: "Not connected", variant: "outline" },
  setup_incomplete: { label: "Setup incomplete", variant: "info" },
  ready: { label: "Ready", variant: "success" },
  degraded: { label: "Degraded", variant: "warning" },
  disconnected: { label: "Disconnected", variant: "error" },
};

const AGENT_NAMES = { dispatch: "Dispatch", sales: "Sales", recruiter: "Recruiter", retention: "Retention", quality: "Quality" } as const;
type AgentId = keyof typeof AGENT_NAMES;

/** Settings › Integrations › Quo: connecting the company's own Quo (formerly OpenPhone) account, step by step. */
export function QuoSetupScreen() {
  const { companyId } = useCompany();
  const view = useQuery(api.quo.connection, { companyId });
  return (
    <div className="grid gap-5">
      <Link href="/app/settings/integrations" className="text-sm font-medium text-muted-foreground hover:text-strong">
        ← Integrations
      </Link>
      <PageHeader title="Quo" lead="Already text your customers and cleaners from Quo (formerly OpenPhone)? Connect it, and Selestial's agents can text through your own numbers. Replies and delivery updates come back to Selestial, and every conversation stays in Quo too." />
      {view === undefined ? <Skeleton className="h-96 rounded-2xl" /> : <Body view={view} />}
    </div>
  );
}

function Body({ view }: { view: View }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATE[view.state].variant}>{STATE[view.state].label}</Badge>
        {view.state !== "not_connected" && view.problem ? <span className="text-sm text-warning-foreground">{view.problem.words}</span> : null}
      </div>
      {view.state === "not_connected" || view.state === "disconnected" ? <Connect view={view} /> : null}
      <Steps view={view} />
      {view.state !== "not_connected" && view.state !== "disconnected" ? <Manage view={view} /> : null}
      <Readiness view={view} />
      <Panel title="What Selestial can't check in Quo">
        <ul className="grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
          {view.readiness.limitations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">Powered by Quo (formerly OpenPhone). Texts sent through Quo are paid for in your Quo account.</p>
      </Panel>
    </>
  );
}

function Connect({ view }: { view: View }) {
  const { companyId } = useCompany();
  const connect = useMutation(api.quo.connect);
  const { busy, error, run } = useRun();
  const [key, setKey] = useState("");
  return (
    <Panel title={view.state === "disconnected" ? "Connect Quo again" : "Connect Quo"}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid gap-2 text-sm text-muted-foreground">
          <p className="font-medium text-strong">What you need</p>
          <ul className="grid list-disc gap-1 pl-5">
            <li>A Quo workspace where you’re an owner or admin.</li>
            <li>An approved carrier registration in Quo for US business texting (A2P 10DLC, or toll-free verification).</li>
            <li>Quo auto-replies and AI agents switched off on the numbers you’ll give Selestial, so two systems don’t answer the same person.</li>
          </ul>
          <p className="font-medium text-strong">Make a key just for Selestial</p>
          <ol className="grid list-decimal gap-1 pl-5">
            <li>In Quo, open Workspace Settings › API.</li>
            <li>Choose Generate API key and name it “Selestial”.</li>
            <li>Copy it and paste it here. It’s stored encrypted and never shown again. Deleting it in Quo stops Selestial at once.</li>
          </ol>
        </div>
        {view.canManage ? (
          <form
            className="grid content-start gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await connect({ companyId, apiKey: key });
                setKey("");
              });
            }}
          >
            <Field label="Quo API key" hint="Checked with Quo before anything else happens.">
              <TextInput type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={key.trim().length < 16} className="justify-self-start">
              Connect Quo
            </Button>
            <FormError message={error} />
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Only the company’s Owner can connect Quo.</p>
        )}
      </div>
    </Panel>
  );
}

function Steps({ view }: { view: View }) {
  return (
    <Panel title="Setup">
      <ol className="grid gap-2">
        {view.readiness.steps.map((step) => (
          <li key={step.key} className="flex gap-2 text-sm">
            {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span>
              <span className={cn("font-medium", step.done ? "text-strong" : "text-strong")}>{step.label}</span>
              <span className="block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Manage({ view }: { view: Connected }) {
  const { companyId } = useCompany();
  const selectNumbers = useMutation(api.quo.selectNumbers);
  const setAgents = useMutation(api.quo.setAgents);
  const setUseForNew = useMutation(api.quo.setUseForNew);
  const confirmRegistration = useMutation(api.quo.confirmRegistration);
  const sendTest = useMutation(api.quo.sendTest);
  const recheck = useMutation(api.quo.recheck);
  const rotateKey = useMutation(api.quo.rotateKey);
  const disconnect = useMutation(api.quo.disconnect);
  const { busy, error, run } = useRun();
  const [testTo, setTestTo] = useState("");
  const [owned, setOwned] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const can = view.canManage;
  const selected = new Set(view.selected.map((n) => n.id));
  const regNeedsOwner = view.registration.status === "none" || view.registration.status === "unknown";

  return (
    <>
      <Panel title="Numbers Selestial may text from">
        {view.available.length === 0 ? (
          <p className="text-sm text-muted-foreground">{view.checkedAt ? "Quo shows no numbers for this key." : "Checking with Quo…"}</p>
        ) : (
          <ul className="grid gap-2">
            {view.available.map((n) => (
              <li key={n.id}>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(n.id)}
                    disabled={!can || busy}
                    onCheckedChange={(checked) => void run(() => selectNumbers({ companyId, numberIds: checked ? [...selected, n.id] : [...selected].filter((id) => id !== n.id) }))}
                  />
                  <span className="text-strong">{n.phoneNumber}</span>
                  {n.name ? <span className="text-xs text-muted-foreground">{n.name}</span> : null}
                  {n.usMessaging === "restricted" ? <Badge variant="warning" size="sm">Quo restricts US texting on this number</Badge> : null}
                </label>
              </li>
            ))}
          </ul>
        )}
        {view.selected.length > 0 ? (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <Checkbox checked={view.useForNew} disabled={!can || busy} onCheckedChange={(checked) => void run(() => setUseForNew({ companyId, use: checked }))} />
            Use {view.selected[0].phoneNumber} for new conversations. Conversations that already exist keep the number they started on.
          </label>
        ) : null}
      </Panel>

      {regNeedsOwner && can ? (
        <Panel title="Carrier registration">
          <p className="text-sm text-muted-foreground">Quo doesn’t show a registration for this workspace, so Selestial can’t verify it (toll-free numbers are verified separately in Quo). Confirm it only once Quo shows it as approved.</p>
          <Button size="sm" variant="secondary" className="mt-2" loading={busy} onClick={() => void run(() => confirmRegistration({ companyId, confirm: true }))}>
            I confirm my numbers are registered
          </Button>
        </Panel>
      ) : null}

      <Panel title="Test text and reply">
        <p className="text-sm text-muted-foreground">Selestial sends one text to your own mobile. Reply to it from your phone: once your reply arrives here, replies are proven to reach Selestial. Nothing else is sent through Quo until then.</p>
        {view.test ? (
          <p className="mt-2 text-sm text-strong">
            {view.test.replyAt ? `Reply received from ${view.test.to}.` : view.test.problem ? `The test didn't go: ${view.test.problem}` : view.test.sent ? `Sent to ${view.test.to}. Reply to it from your phone.` : `Sending to ${view.test.to}…`}
          </p>
        ) : null}
        {can && view.selected.length > 0 ? (
          <form
            className="mt-3 grid gap-2 sm:max-w-md"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => sendTest({ companyId, to: testTo, fromNumberId: view.selected[0].id, ownNumber: true }));
            }}
          >
            <Field label="Your mobile number">
              <TextInput inputMode="tel" value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder="(512) 555-0142" />
            </Field>
            <label className="flex items-center gap-2 text-xs text-strong">
              <Checkbox checked={owned} onCheckedChange={(checked) => setOwned(checked)} />
              This is my own phone.
            </label>
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!owned || testTo.trim().length < 10} className="justify-self-start">
              Send test text
            </Button>
          </form>
        ) : null}
      </Panel>

      <Panel title="Agents allowed to text through Quo">
        <ul className="grid gap-3">
          {view.readiness.agents.map((line) => (
            <li key={line.agent} className="rounded-xl border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-strong">
                <Checkbox
                  checked={view.agents.includes(line.agent as AgentId)}
                  disabled={!can || busy}
                  onCheckedChange={(checked) => void run(() => setAgents({ companyId, agents: checked ? [...view.agents, line.agent as AgentId] : view.agents.filter((agent) => agent !== line.agent) }))}
                />
                {AGENT_NAMES[line.agent as AgentId]}
              </label>
              <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-[8rem_1fr]">
                <dt>Who it texts</dt>
                <dd className="text-strong">{line.workflow.audience}</dd>
                <dt>From</dt>
                <dd className="text-strong">{line.workflow.sender}</dd>
                <dt>When</dt>
                <dd className="text-strong">{line.workflow.trigger}</dd>
                <dt>Approval</dt>
                <dd className="text-strong">{line.workflow.approval}</dd>
                <dt>What it does</dt>
                <dd className="text-strong">{line.workflow.behavior}</dd>
              </dl>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Health and recovery">
        <p className="text-sm text-muted-foreground">
          Key ending {view.keyHint}. {view.checkedAt ? `Last checked ${new Date(view.checkedAt).toLocaleString()}.` : ""} {view.webhook?.lastEventAt ? `Last event from Quo ${new Date(view.webhook.lastEventAt).toLocaleString()}.` : ""}
        </p>
        {view.errors.length > 0 ? (
          <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
            {view.errors.map((row) => (
              <li key={row.at}>
                {new Date(row.at).toLocaleString()}: {row.words}
              </li>
            ))}
          </ul>
        ) : null}
        {can ? (
          <div className="mt-3 grid gap-3">
            <Button size="sm" variant="secondary" className="justify-self-start" loading={busy} onClick={() => void run(() => recheck({ companyId }))}>
              Check again with Quo
            </Button>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await rotateKey({ companyId, apiKey: newKey });
                  setNewKey("");
                });
              }}
            >
              <Field label="Replace the key" hint="It's used only once Quo accepts it for the same workspace.">
                <TextInput type="password" autoComplete="off" value={newKey} onChange={(event) => setNewKey(event.target.value)} />
              </Field>
              <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={newKey.trim().length < 16}>
                Replace key
              </Button>
            </form>
            {confirmDisconnect ? (
              <div className="grid gap-2 rounded-xl bg-warning/10 p-3 text-sm">
                <p className="text-warning-foreground">Disconnecting stops every text through Quo now{view.agents.length ? ` for ${view.agents.map((agent) => AGENT_NAMES[agent as AgentId]).join(", ")}` : ""}. Conversations and history are kept. Texts that were waiting won’t be sent later.</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" loading={busy} onClick={() => void run(() => disconnect({ companyId }))}>
                    Disconnect Quo
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                    Keep it connected
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setConfirmDisconnect(true)}>
                Disconnect…
              </Button>
            )}
          </div>
        ) : null}
        <FormError message={error} />
      </Panel>
    </>
  );
}

function Readiness({ view }: { view: View }) {
  return (
    <Panel title="What each agent can do now">
      <ul className="grid gap-1.5 text-sm">
        {view.readiness.agents.map((line) => (
          <li key={line.agent} className="flex gap-2">
            {line.state === "ready" || line.state === "drafts" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="text-strong">{line.words}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">While texting isn’t ready you can keep setting up: import records, review applicants, check coverage and prepare drafts. Connecting never texts your imported contacts.</p>
    </Panel>
  );
}
