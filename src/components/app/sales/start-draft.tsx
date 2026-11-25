"use client";

import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { messageOf } from "@/components/app/form";
import { useDeclareNavOwner } from "@/components/app/nav-owner";
import { workspaceHref, workspaceOwner } from "@/lib/app/sales-workspace";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

const SEGMENTS = ["residential", "commercial", "office", "str"] as const;
const PENDING = "selestial.sales.start:";

/**
 * The key for this visit's draft. An entry point's own key wins. Otherwise one is kept for this address in
 * this browser tab until the draft is made, so reloading or retrying while it is being made returns the same
 * draft, and a later visit to the same link, once that draft exists, starts a new one.
 */
function visitKey(given: string | undefined): { key: string; done: () => void } {
  if (given) return { key: given, done: () => {} };
  const slot = PENDING + window.location.pathname + window.location.search;
  const fresh = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const kept = window.sessionStorage.getItem(slot);
    if (kept) return { key: kept, done: () => window.sessionStorage.removeItem(slot) };
    window.sessionStorage.setItem(slot, fresh);
    return { key: fresh, done: () => window.sessionStorage.removeItem(slot) };
  } catch {
    // Storage refused (private mode, quota): the key still covers this visit's own retries.
    return { key: fresh, done: () => {} };
  }
}

/**
 * Opens the workspace from any entry point (Sales, a customer, Dispatch), with what that entry point
 * knows filled in. An opportunity always reopens its own draft rather than starting a second one.
 */
export function StartDraft(props: { mode: "booking" | "proposal"; segment?: string; kind?: string; customerId?: string; propertyId?: string; opportunityId?: string; jobId?: string; from?: string; clientKey?: string }) {
  const { companyId } = useCompany();
  const router = useRouter();
  useDeclareNavOwner(workspaceOwner(props.mode));
  const start = useMutation(api.sales.startDraft);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const visit = visitKey(props.clientKey);
    const segment = SEGMENTS.find((s) => s === props.segment);
    start({
      companyId,
      mode: props.mode,
      ...(segment ? { segment } : {}),
      ...(props.kind === "recurring" ? { bookingKind: "recurring" as const } : {}),
      ...(props.customerId ? { customerId: props.customerId as Id<"customers"> } : {}),
      ...(props.propertyId ? { propertyId: props.propertyId as Id<"properties"> } : {}),
      ...(props.opportunityId ? { opportunityId: props.opportunityId as Id<"salesOpportunities"> } : {}),
      ...(props.jobId ? { jobId: props.jobId as Id<"jobs"> } : {}),
      ...(props.from ? { from: props.from } : {}),
      // Reloading or retrying this address while the draft is made returns that draft, not a second one.
      clientKey: visit.key,
    })
      // Replaced, not pushed: Back from the workspace skips this page instead of starting another draft.
      .then((draftId) => {
        visit.done();
        router.replace(workspaceHref(draftId, props.from));
      })
      .catch((caught: unknown) => setError(messageOf(caught)));
  }, [companyId, props, router, start]);
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive-foreground">
        {error}
      </p>
    );
  return <Skeleton className="h-[60vh] rounded-2xl" />;
}
