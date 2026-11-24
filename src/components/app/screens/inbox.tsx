"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.smsConversations.list>>>[number];

const OWNER_BADGE: Record<Row["owner"], { label: string; variant: "outline" | "info" | "warning" | "success" }> = {
  agents: { label: "Agents", variant: "success" },
  member: { label: "A person", variant: "info" },
  external: { label: "Answered in Quo", variant: "warning" },
  review: { label: "Needs review", variant: "warning" },
};

const PROVIDER = { quo: "Quo", native: "Selestial number" } as const;

function when(at: number | null): string {
  return at ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

/** Inbox: every text conversation, whichever number carries it, with who answers it and a way to take over. */
export function ConversationsScreen() {
  const { companyId } = useCompany();
  const rows = useQuery(api.smsConversations.list, { companyId });
  const [open, setOpen] = useState<Id<"smsConversations"> | null>(null);
  const lead = "Every text conversation, from your Selestial number or your connected Quo numbers, with who answers each one. Take over whenever you want; agents stop writing the moment you do.";
  if (rows === undefined) {
    return (
      <>
        <PageHeader title="Inbox" lead={lead} />
        <Skeleton className="h-96 rounded-2xl" />
      </>
    );
  }
  const current = open ?? rows[0]?.conversationId ?? null;
  return (
    <>
      <PageHeader title="Inbox" lead={lead} />
      {rows.length === 0 ? (
        <Panel>
          <p className="text-sm text-muted-foreground">No text conversations yet. They appear here as soon as a text is sent or received, from your Selestial number or a connected Quo number.</p>
          <Link href="/app/settings/integrations" className="mt-2 inline-block text-sm font-medium text-strong underline-offset-2 hover:underline">
            Set up texting in Integrations
          </Link>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
          <ul className="grid content-start gap-2" aria-label="Conversations">
            {rows.map((row) => (
              <li key={row.conversationId}>
                <button
                  type="button"
                  onClick={() => setOpen(row.conversationId)}
                  aria-current={row.conversationId === current ? "true" : undefined}
                  className={cn("w-full rounded-xl border p-3 text-left transition-colors", row.conversationId === current ? "border-brand-500 bg-brand-500/5" : "border-border bg-card hover:bg-muted/50")}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-strong">{row.people.map((p) => p.name).join(", ") || row.address}</span>
                    <Badge variant={OWNER_BADGE[row.owner].variant} size="sm">
                      {OWNER_BADGE[row.owner].label}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {PROVIDER[row.provider]} · {row.sender} · {when(row.lastInboundAt ?? row.lastOutboundAt)}
                  </span>
                  {row.agentsPaused ? <span className="mt-1 block text-xs text-warning-foreground">Agent replies paused</span> : null}
                  {row.blocked ? <span className="mt-1 block text-xs text-warning-foreground">{row.blocked}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {current ? <Thread conversationId={current} /> : null}
        </div>
      )}
    </>
  );
}

function Thread({ conversationId }: { conversationId: Id<"smsConversations"> }) {
  const { companyId, role } = useCompany();
  const thread = useQuery(api.smsConversations.thread, { companyId, conversationId });
  const members = useQuery(api.members.list, { companyId });
  const takeOver = useMutation(api.smsConversations.takeOver);
  const pause = useMutation(api.smsConversations.pauseAgents);
  const assign = useMutation(api.smsConversations.assign);
  const back = useMutation(api.smsConversations.returnToAgents);
  const { busy, error, run } = useRun();
  if (thread === undefined) return <Skeleton className="h-96 rounded-2xl" />;
  if (thread === null) return <Panel><p className="text-sm text-muted-foreground">This conversation isn’t available.</p></Panel>;
  const mine = thread.owner.kind === "member" && thread.owner.memberId === thread.me;
  const manager = role === "owner" || role === "manager";
  return (
    <section className="grid content-start gap-3 rounded-2xl border border-border bg-card p-4">
      <header className="grid gap-1">
        <h2 className="font-heading text-lg text-strong">{thread.people.map((p) => p.name).join(", ") || thread.address}</h2>
        <p className="text-xs text-muted-foreground">
          {thread.address} · via {PROVIDER[thread.provider]} from {thread.sender}
          {thread.people.length > 0 ? ` · ${thread.people.map((p) => p.kind).join(", ")}` : " · not on any record"}
        </p>
        {thread.connection && thread.connection.status !== "ready" ? (
          <p className="rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground">
            {thread.connection.problem ?? "The Quo connection isn't ready, so nothing is sent in this conversation."}{" "}
            <Link href="/app/settings/integrations/quo" className="font-medium underline-offset-2 hover:underline">
              Open the Quo connection
            </Link>
          </p>
        ) : null}
      </header>

      <div className="grid gap-2 rounded-xl bg-muted/50 p-3 text-sm">
        <p>
          <span className="font-medium text-strong">Answered by: {thread.ownerWords}</span>
          {thread.agentsPaused ? <span className="text-warning-foreground"> · agent replies paused</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">Why: {thread.ownerReason}</p>
        <div className="flex flex-wrap gap-2">
          {!mine ? (
            <Button size="xs" variant="primary" loading={busy} onClick={() => void run(() => takeOver({ companyId, conversationId }))}>
              Take over conversation
            </Button>
          ) : null}
          <Button size="xs" variant="secondary" loading={busy} onClick={() => void run(() => pause({ companyId, conversationId, paused: !thread.agentsPaused }))}>
            {thread.agentsPaused ? "Resume agent replies" : "Pause agent replies"}
          </Button>
          {thread.owner.kind !== "agents" || thread.agentsPaused ? (
            <Button size="xs" variant="secondary" loading={busy} onClick={() => void run(() => back({ companyId, conversationId }))}>
              Return to agent
            </Button>
          ) : null}
          {manager && members ? (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Assign to
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-strong"
                value=""
                disabled={busy}
                onChange={(event) => event.target.value && void run(() => assign({ companyId, conversationId, memberId: event.target.value as Id<"members"> }))}
              >
                <option value="">Choose…</option>
                {members
                  .filter((m) => m.status === "active")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
        <FormError message={error} />
      </div>

      {thread.openTasks.length > 0 ? (
        <ul className="grid gap-1 rounded-xl border border-warning/40 p-3 text-xs">
          {thread.openTasks.map((task) => (
            <li key={task.taskId}>
              <span className="font-medium text-strong">{task.title}</span>
              {task.question ? <span className="block text-muted-foreground">{task.question}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="grid gap-2" aria-label="Messages">
        {thread.items.length === 0 ? <li className="text-sm text-muted-foreground">No texts yet.</li> : null}
        {thread.items.map((item) => (
          <li key={item.id} className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", item.direction === "incoming" ? "justify-self-start bg-muted text-strong" : "justify-self-end bg-brand-500/10 text-strong")}>
            <p className="whitespace-pre-wrap">{item.body}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {when(item.at)}
              {item.direction === "outgoing" ? ` · ${item.by} · ${item.statusWords}` : ""}
              {item.direction === "outgoing" && item.provider ? ` · ${item.provider === "quo" ? "Quo" : "Selestial number"}` : ""}
            </p>
            {item.problem ? <p className="mt-1 text-[11px] text-warning-foreground">{item.problem}</p> : null}
            {item.outcome ? <p className="mt-1 text-[11px] font-medium text-strong">Outcome: {item.outcome}</p> : null}
          </li>
        ))}
      </ol>
      <Composer conversationId={conversationId} mine={mine} />
    </section>
  );
}

/**
 * A person writing in the conversation. It goes through the same sending policy as every business text
 * (their permission, STOP, sending hours, the company's pause and balance), and sending takes the
 * conversation for this person, so agents stop writing in it until it's returned. Whatever stops a message
 * shows on it in the thread.
 */
function Composer({ conversationId, mine }: { conversationId: Id<"smsConversations">; mine: boolean }) {
  const { companyId } = useCompany();
  const reply = useMutation(api.smsConversations.reply);
  const { busy, error, run } = useRun();
  const [body, setBody] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const remaining = 1500 - body.length;
  return (
    <form
      className="grid gap-2 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const sent = await reply({ companyId, conversationId, body, clientKey: key });
          setBody("");
          setKey(crypto.randomUUID());
          setNote(sent.status === "queued" ? "Sending." : sent.problem ? `Not sent yet: ${sent.problem}` : null);
        });
      }}
    >
      <label htmlFor={`reply-${conversationId}`} className="text-sm font-medium text-strong">
        Reply
      </label>
      <textarea
        id={`reply-${conversationId}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={1500}
        className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-strong outline-none focus-visible:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500/30"
        aria-describedby={`reply-help-${conversationId}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`reply-help-${conversationId}`} className="text-xs text-muted-foreground">
          {mine ? "You have this conversation; agents won't write in it until you return it." : "Sending takes this conversation for you; agents stop writing in it until it's returned."} {remaining < 200 ? `${remaining} characters left.` : ""}
        </p>
        <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
          Send
        </Button>
      </div>
      {error ? <FormError message={error} /> : note ? <p className="text-xs text-muted-foreground" aria-live="polite">{note}</p> : null}
    </form>
  );
}
