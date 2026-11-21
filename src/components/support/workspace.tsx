"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { Component, useEffect, useState, useSyncExternalStore } from "react";

import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { useNow } from "@/components/app/use-now";
import { useSignOut } from "@/components/auth/user-menu";
import { ShieldCheck } from "@/components/icons";
import { storedSession, storeSession } from "@/components/support/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * The support session this tab holds. A tab opened with ?support=<id> takes it into its own
 * sessionStorage once and drops it from the address, so a copied link or another tab never inherits it.
 */
export function useSupportTab(): Id<"supportSessions"> | null | undefined {
  // undefined until this tab's storage has been read, so an ordinary workspace never flashes first.
  const [id, setId] = useState<Id<"supportSessions"> | null | undefined>(undefined);
  useEffect(() => {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("support");
    if (fromUrl && /^[a-z0-9]{8,64}$/i.test(fromUrl)) {
      storeSession(fromUrl as Id<"supportSessions">);
      url.searchParams.delete("support");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this tab's own storage after mount
    setId(storedSession());
  }, []);
  return id;
}

/** Whether the client has mounted (sessionStorage is not readable on the server). */
export function useMounted() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

const ROLE_WORDS: Record<string, string> = { owner: "Owner", manager: "Manager", office: "Office" };

type Current = NonNullable<ReturnType<typeof useQuery<typeof api.support.current>>>;

/**
 * The banner on every screen of a support session: who is being helped, View or Manage, when it ends,
 * and the controls. Distinct (a deep violet band) without shouting.
 */
export function SupportBanner({ session }: { session: Current }) {
  const now = useNow();
  const router = useRouter();
  const pathname = usePathname();
  const exit = useMutation(api.support.exit);
  const setMode = useMutation(api.support.setMode);
  const setPreview = useMutation(api.support.setPreview);
  const noteView = useMutation(api.support.noteView);
  const [manage, setManage] = useState(false);
  const { busy, error, run } = useRun();
  const minutes = now ? Math.max(0, Math.ceil((session.expiresAt - now) / 60_000)) : null;

  // Pages opened are part of the session's record.
  useEffect(() => {
    void noteView({ sessionId: session.id, label: pathname.replace(/^\/app/, "") || "Home" }).catch(() => undefined);
  }, [noteView, pathname, session.id]);

  const leave = () =>
    void run(async () => {
      await exit({ sessionId: session.id });
      storeSession(null);
      router.push("/staff/operations?view=activity");
    });

  return (
    <div role="region" aria-label="Admin support session" className={cn("sticky top-14 z-10 border-b px-3 py-2 text-sm sm:px-6", session.mode === "manage" ? "border-amber-300/60 bg-[#2b1d55] text-white" : "border-brand-300/40 bg-[#211a35] text-white")}>
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-brand-300" aria-hidden />
          <span className="truncate">
            <span className="font-semibold">Admin support session</span> · {session.company.name} ·{" "}
            <span className={cn("rounded px-1.5 py-0.5 text-xs font-semibold", session.mode === "manage" ? "bg-amber-300 text-[#211a35]" : "bg-white/15")}>{session.mode === "manage" ? "Manage" : "View only"}</span>
            {session.mode === "view" && session.previewRole !== "owner" ? <span className="ml-1 text-xs text-white/70">(viewing as {ROLE_WORDS[session.previewRole]})</span> : null}
          </span>
        </p>
        <p className="text-xs text-white/75" aria-live="polite">
          {minutes === null ? "" : minutes <= 1 ? "Session expires in under a minute." : `Session expires in ${minutes} minutes.`}
          {session.changes ? ` ${session.changes} change${session.changes === 1 ? "" : "s"} made.` : ""}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {session.mode === "view" ? (
            <label className="flex items-center gap-1 text-xs text-white/80">
              View as
              <select
                value={session.previewRole}
                onChange={(event) => void run(() => setPreview({ sessionId: session.id, role: event.target.value as "owner" | "manager" | "office" }))}
                className="rounded border border-white/25 bg-white/10 px-1.5 py-0.5 text-xs text-white focus-visible:outline-2 focus-visible:outline-brand-300"
              >
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="office">Office</option>
              </select>
            </label>
          ) : null}
          {session.mode === "view" ? (
            session.canManage ? (
              <Button size="xs" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10" onClick={() => setManage(!manage)}>
                Switch to Manage
              </Button>
            ) : null
          ) : (
            <Button size="xs" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10" loading={busy} onClick={() => void run(() => setMode({ sessionId: session.id, mode: "view" }))}>
              Back to View
            </Button>
          )}
          <Button size="xs" variant="secondary" loading={busy} onClick={leave}>
            Exit session
          </Button>
        </div>
      </div>
      {manage && session.mode === "view" ? <ManageSwitch sessionId={session.id} onDone={() => setManage(false)} /> : null}
      {error ? <p className="mx-auto mt-1 max-w-[1500px] text-xs text-amber-200">{error}</p> : null}
    </div>
  );
}

function ManageSwitch({ sessionId, onDone }: { sessionId: Id<"supportSessions">; onDone: () => void }) {
  const verification = useQuery(api.support.verification, {});
  const setMode = useMutation(api.support.setMode);
  const signOut = useSignOut();
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  return (
    <form
      className="mx-auto mt-2 grid max-w-[1500px] gap-2 rounded-lg bg-white p-3 text-[#211a35] sm:grid-cols-[1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await setMode({ sessionId, mode: "manage", reason });
          onDone();
        });
      }}
    >
      <Field label="What you need to change, and why" hint="The Owner is emailed this when you switch. Approvals, messages to their customers, publishing prices, buying numbers and money stay theirs.">
        <TextArea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required minLength={10} />
      </Field>
      <div className="grid gap-1.5">
        {verification && !verification.ok ? (
          <>
            <p className="max-w-xs text-xs text-[#9a3412]">{verification.words}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void signOut()}>
              Sign in again
            </Button>
          </>
        ) : (
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={reason.trim().length < 10}>
            Switch to Manage
          </Button>
        )}
      </div>
      <FormError message={error} />
    </form>
  );
}

/** What the tab shows when its session has ended: support access is gone, and the way back. */
export function SupportEnded({ reason, onBack }: { reason: string | null; onBack: () => void }) {
  const words = reason === "expired" ? "This support session expired." : reason === "revoked" || reason === "staff_removed" ? "This support session was revoked." : "This support session has ended.";
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/50 p-6">
      <div className="max-w-md rounded-2xl border border-border bg-card p-6 text-center">
        <ShieldCheck className="mx-auto size-8 text-brand-500" aria-hidden />
        <h1 className="mt-3 font-heading text-xl text-strong">{words}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Access to the company&apos;s workspace stopped the moment it ended. Everything you did is in the session&apos;s record.</p>
        <Button className="mt-4" variant="primary" onClick={onBack}>
          Return to the staff console
        </Button>
      </div>
    </main>
  );
}

/** A request refused because the session ended shows the ended screen, never a crashed page. */
export class SupportBoundary extends Component<{ children: React.ReactNode; onEnded: () => void }, { ended: boolean }> {
  state = { ended: false };
  static getDerivedStateFromError(error: unknown) {
    const code = (error as { data?: { code?: string } } | null)?.data?.code;
    if (code === "support_ended" || code === "not_found") return { ended: true };
    throw error;
  }
  render() {
    if (this.state.ended) return <SupportEnded reason={null} onBack={this.props.onEnded} />;
    return this.props.children;
  }
}
