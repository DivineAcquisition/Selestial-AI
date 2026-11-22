"use client";

/**
 * "Stop using this number": the owner asks Selestial to release the company's texting number, or says it
 * is moving to another provider (docs/texting/03-offboarding.md). Asking changes nothing by itself: the number
 * keeps working and its fees continue until Selestial completes the release or the transfer finishes. A
 * release is permanent, so it needs the owner's explicit acceptance of the exact words the server keeps.
 * Kept quiet on purpose: a closed disclosure at the bottom of the progress step.
 */
import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";

import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/fields";
import { Checkbox, SelectionCards } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";
import { formatPhone, useSetup } from "./context";
import { Note } from "./parts";

type Route = "port_out" | "release";

const OPTIONS = [
  { value: "port_out", label: "Move my number to another provider", description: "Keep the number. Your new provider starts the transfer." },
  { value: "release", label: "Release my number", description: "Give the number up for good. This can't be undone." },
] as const;

const day = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function StopNumber() {
  const { view, companyId } = useSetup();
  const request = view.request;
  const data = useQuery(api.textingCase.workspace, { companyId });
  const ask = useMutation(api.textingCase.requestOffboarding);
  const cancel = useMutation(api.textingCase.cancelOffboarding);
  const { busy, error, run } = useRun();
  const [route, setRoute] = useState<Route | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [words, setWords] = useState("");
  const titleId = useId();
  if (!request || (request.status !== "active" && request.status !== "interrupted")) return null;
  const number = formatPhone(request.phoneNumber);
  const items = (data?.exceptions ?? []).filter((row) => row.state !== "resolved" && (row.assisted?.route === "release" || row.assisted?.route === "port_out") && row.assisted.phoneNumber === request.phoneNumber);
  const open = items.find((row) => row.assisted?.authorization);
  // Opened by Selestial when the plan was cancelled: it explains, but it is not the owner's request.
  const notice = items.find((row) => !row.assisted?.authorization);
  const started = request.offboarding !== null;
  const owner = data?.viewer.kind === "owner";
  const wording = route === "release" ? data?.catalog.releaseWording : data?.catalog.portOutWording;

  return (
    <section className="grid gap-2 border-t border-border pt-5" aria-labelledby={titleId}>
      <Disclosure
        title={<span id={titleId}>Stop using this number</span>}
        summary={open ? (open.assisted?.route === "release" ? "A release is requested." : "A transfer to another provider is requested.") : "Move it to another provider, or release it."}
        defaultOpen={Boolean(open || notice)}
      >
        {data === undefined ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : data === null ? null : open ? (
          <div className="grid gap-3 text-sm">
            <div className="grid gap-1.5 rounded-xl border border-border p-3">
              <p className="flex flex-wrap items-center gap-2">
                <Badge variant={started ? "warning" : "info"}>{started ? "Selestial has started" : open.state === "waiting_provider" ? "Waiting on the transfer" : "With Selestial"}</Badge>
                <span className="font-medium whitespace-nowrap text-strong tabular-nums">{number}</span>
              </p>
              <p className="text-strong">{open.ownerWords}</p>
              <p className="text-xs text-muted-foreground">Next: {open.nextAction}</p>
              {open.followUpAt && !started ? <p className="text-xs text-muted-foreground">Selestial expects to follow up by {day(open.followUpAt)}. That&apos;s what usually happens, not a guarantee.</p> : null}
            </div>
            <Note>Until this completes, {number} keeps working and its monthly number and registration fees continue. Setup fees already paid aren&apos;t refunded.</Note>
            {started ? (
              <Note tone="warning">Selestial has started on this, so it can&apos;t be cancelled here. If something is wrong, write to support right away.</Note>
            ) : owner ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" loading={busy} onClick={() => void run(() => cancel({ companyId, exceptionId: open.id }))}>
                  {open.assisted?.route === "release" ? "Cancel the release request" : "Cancel the transfer request"}
                </Button>
                <p className="text-xs text-muted-foreground">Cancelling changes nothing about your number. You can ask again later.</p>
              </div>
            ) : null}
            <FormError message={error} />
          </div>
        ) : !owner ? (
          <p className="text-sm text-muted-foreground">Only the Owner can ask to release or move the company&apos;s number.</p>
        ) : (
          <form
            className="grid gap-4 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              if (!route || !wording || !accepted) return;
              void run(async () => {
                await ask({ companyId, route, acknowledgement: wording, words: words.trim() || undefined });
                setAccepted(false);
                setWords("");
                setRoute(null);
              });
            }}
          >
            {notice ? <Note tone="warning">{notice.ownerWords}</Note> : null}
            <p className="text-muted-foreground">
              Asking doesn&apos;t change anything by itself. {number} keeps working, and its monthly number and registration fees continue, until the release or transfer completes. Setup fees already paid aren&apos;t refunded.
            </p>
            <SelectionCards
              type="single"
              aria-label="What to do with this number"
              columns={2}
              options={OPTIONS}
              value={route}
              onValueChange={(value) => {
                setRoute(value);
                setAccepted(false);
              }}
            />
            {route === "port_out" ? (
              <div className="grid gap-2">
                <p className="font-medium text-strong">Moving {number} to another provider</p>
                <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
                  <li>Your new provider starts the transfer, not Selestial. Ask them to bring this number over; they&apos;ll tell you what they need.</li>
                  <li>A transfer typically takes several business days. The date is set by the providers and isn&apos;t guaranteed.</li>
                  <li>While it&apos;s under way, Selestial keeps the number active and will not release it, so your texts keep working here.</li>
                  <li>Once it completes, Selestial stops sending texts from this number, closes its carrier registration here, and its monthly fees stop.</li>
                </ul>
                <p className="text-xs text-muted-foreground">What happens next: Selestial sees your request, typically within 2 business days, and confirms here once the transfer has completed. If your new provider asks for details only Selestial has, ask in Evidence &amp; notes.</p>
              </div>
            ) : null}
            {route === "release" ? (
              <div className="grid gap-2">
                <p className="font-medium text-strong">Releasing {number}</p>
                <Note tone="warning">Releasing is permanent. The number can&apos;t be recovered, customers and cleaners who text or call it won&apos;t reach you, and its carrier registration ends.</Note>
                <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
                  <li>Nothing is released when you ask. A person at Selestial reviews the request first, typically within 2 business days.</li>
                  <li>You can cancel the request here until Selestial starts the release.</li>
                  <li>Once it&apos;s released, your agents can&apos;t text until you set up a number again, which is a new registration with the carriers.</li>
                </ul>
              </div>
            ) : null}
            {route ? (
              <>
                <Field label="Anything Selestial should know (optional)">
                  <TextArea rows={2} value={words} onChange={(event) => setWords(event.target.value)} maxLength={1000} />
                </Field>
                <label className="flex items-start gap-3 rounded-xl border border-border p-3.5 text-sm leading-6">
                  <Checkbox checked={accepted} onCheckedChange={setAccepted} className="mt-1 shrink-0" />
                  <span className="text-strong">{wording}</span>
                </label>
                <FormError message={error} />
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" variant={route === "release" ? "destructive-outline" : "primary"} loading={busy} disabled={!accepted}>
                    {route === "release" ? "Ask Selestial to release this number" : "Tell Selestial I'm moving this number"}
                  </Button>
                  {!accepted ? <p className="text-xs text-muted-foreground">Tick the box above to continue.</p> : null}
                </div>
              </>
            ) : null}
          </form>
        )}
      </Disclosure>
    </section>
  );
}
