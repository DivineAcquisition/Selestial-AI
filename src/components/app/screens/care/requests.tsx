"use client";

/**
 * Every client request, searchable and filterable: who, which property and visit, what it is, where it stands,
 * how urgent it is, who has it, what happens next and when the client last heard. Opening one shows the
 * conversation beside its context.
 */
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { TextInput } from "@/components/app/form";
import { PageHeader } from "@/components/app/shell";
import { useNow } from "@/components/app/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/selection";
import { useStableQuery } from "@/lib/app/stable-query";

import { api } from "../../../../../convex/_generated/api";
import { Empty } from "../quality/shared";
import { CARE_LEAD } from "./overview";
import { RequestWorkspace } from "./request-workspace";
import { RequestCard, useRequestParam } from "./shared";

type StatusFilter = "open" | "closed" | "new" | "in_progress" | "waiting_customer" | "waiting_team" | "waiting_owner" | "resolved" | "closed_no_action";
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "All open" },
  { value: "waiting_owner", label: "Waiting for you" },
  { value: "waiting_customer", label: "Waiting for client" },
  { value: "waiting_team", label: "Waiting for team" },
  { value: "in_progress", label: "In progress" },
  { value: "new", label: "New" },
  { value: "closed", label: "All closed" },
  { value: "resolved", label: "Resolved" },
  { value: "closed_no_action", label: "Closed without action" },
];

export function CareRequestsScreen() {
  const { companyId, timezone } = useCompany();
  const now = useNow();
  const params = useSearchParams();
  const { openId, open, close } = useRequestParam();
  const initial = (params.get("status") as StatusFilter | null) ?? "open";
  const [status, setStatus] = useState<StatusFilter>(STATUS_OPTIONS.some((o) => o.value === initial) ? initial : "open");
  const [category, setCategory] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<"normal" | "high" | "urgent" | null>(null);
  const [search, setSearch] = useState("");
  const list = useStableQuery(api.clientCare.list, { companyId, status, ...(category ? { category: category as never } : {}), ...(urgency ? { urgency } : {}), ...(search.trim() ? { search: search.trim() } : {}) });
  return (
    <>
      <PageHeader title="Requests" lead={CARE_LEAD} />
      <div className="grid gap-4">
        <div className="grid gap-3 rounded-2xl border border-border bg-card p-3.5 sm:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Search
            <TextInput type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Client, contact, property or words" aria-label="Search requests" />
          </label>
          <div className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span id="care-status">Status</span>
            <Select aria-labelledby="care-status" value={status} onValueChange={(value) => setStatus((value ?? "open") as StatusFilter)} options={STATUS_OPTIONS} />
          </div>
          <div className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span id="care-type">Type</span>
            <Select aria-labelledby="care-type" value={category} onValueChange={setCategory} emptyLabel="Every type" placeholder="Every type" options={(list?.categories ?? []).map((c) => ({ value: c.id, label: c.words }))} />
          </div>
          <div className="grid gap-1 text-xs font-medium text-muted-foreground">
            <span id="care-urgency">Urgency</span>
            <Select aria-labelledby="care-urgency" value={urgency} onValueChange={(value) => setUrgency(value as typeof urgency)} emptyLabel="Any" placeholder="Any" options={[{ value: "urgent", label: "Urgent" }, { value: "high", label: "Soon" }, { value: "normal", label: "Normal" }]} />
          </div>
        </div>
        {list === undefined ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading requests">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        ) : list.rows.length ? (
          <div className="grid gap-3" role="list" aria-label="Requests">
            {list.rows.map((card) => (
              <div role="listitem" key={card.id}>
                <RequestCard card={card} now={now} timezone={timezone} onOpen={open} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title={search || category || urgency ? "No request matches" : status === "open" ? "No open requests" : "Nothing here yet"} body={search || category || urgency ? "Change the search or the filters to see more." : "A request is opened when a client texts the company's number or emails the Care & Retention inbox. Every message also stays in the shared Inbox."} />
        )}
      </div>
      <RequestWorkspace id={openId} onClose={close} />
    </>
  );
}
