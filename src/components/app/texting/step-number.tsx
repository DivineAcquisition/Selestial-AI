"use client";

/**
 * Step 4: the company's own local number. Search an area code; each number shows where it is, what it can
 * actually do (as Telnyx reports it) and what it costs each month. Choosing one holds nothing: it is
 * checked again right before it's bought, and never swapped for another without asking.
 */
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { Field, FormError, TextArea, TextInput, useRun } from "@/components/app/form";
import { Checkbox } from "@/components/ui/selection";
import { Check, Phone, Search } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { formatPhone, placeName, useSetup } from "./context";
import { ChoiceCard, Note, Section, StepHeading } from "./parts";

const ROUTES = [
  { value: "new_local", title: "Get a new local number", hint: "Guided and automated: Selestial registers it with the carriers and buys it once they approve." },
  { value: "port_existing", title: "Bring a number you already have", hint: "Assisted: Selestial checks it can move and what your current carrier needs. Nothing moves without your separate signed authorization." },
  { value: "toll_free", title: "Use a toll-free number", hint: "Assisted: toll-free numbers go through their own carrier verification, not this registration." },
] as const;

export function NumberStep() {
  const { view, companyId, run, locked } = useSetup();
  const setRoute = useMutation(api.textingCase.setNumberRoute);
  return (
    <>
      <StepHeading eyebrow="Step 4 of 6" title="Your number" lead="The number customers, cleaners and applicants see on every text." />
      <div role="radiogroup" aria-label="Kind of number" className="grid gap-2 sm:grid-cols-3">
        {ROUTES.map((route) => (
          <ChoiceCard key={route.value} selected={view.route === route.value} disabled={locked} onPress={() => void run((revision) => setRoute({ companyId, revision, route: route.value }))} title={route.title} hint={route.hint}>
            {route.value === "new_local" ? null : <Badge variant="outline">Assisted</Badge>}
          </ChoiceCard>
        ))}
      </div>
      {view.route === "new_local" ? <LocalNumber /> : <AssistedRoute route={view.route} />}
    </>
  );
}

/**
 * Bringing a number or using a toll-free one: saved as a request assigned to Selestial, with its status and
 * next action. Nothing is checked, moved, bought or filed by asking.
 */
function AssistedRoute({ route }: { route: "port_existing" | "toll_free" }) {
  const { companyId } = useSetup();
  const data = useQuery(api.textingCase.workspace, { companyId });
  const ask = useMutation(api.textingCase.requestAssistance);
  const { busy, error, run } = useRun();
  const [phone, setPhone] = useState("");
  const [carrier, setCarrier] = useState("");
  const [words, setWords] = useState("");
  const [accepted, setAccepted] = useState(false);
  if (!data) return <Skeleton className="h-32 rounded-xl" />;
  const open = data.exceptions.find((row) => row.assisted?.route === route && row.state !== "resolved");
  if (open) {
    return (
      <Section title={route === "port_existing" ? "Your request to bring a number" : "Your toll-free request"} lead="Handled with Selestial's help, not automatically.">
        <div className="grid gap-1.5 rounded-xl border border-border p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={open.state === "waiting_owner" ? "warning" : "info"}>{open.state === "waiting_owner" ? "Needs you" : open.state === "waiting_provider" ? "Waiting on the provider" : "With Selestial"}</Badge>
            {open.assisted?.phoneNumber ? <span className="font-medium text-strong tabular-nums">{formatPhone(open.assisted.phoneNumber)}</span> : null}
          </p>
          <p className="text-strong">{open.ownerWords}</p>
          <p className="text-xs text-muted-foreground">Next: {open.nextAction}</p>
          <p className="text-xs text-muted-foreground">{open.canContinue}</p>
          {open.followUpAt ? <p className="text-xs text-muted-foreground">Selestial follows up by {new Date(open.followUpAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.</p> : null}
        </div>
        <Note>Your local-number registration isn&apos;t sent while this is open. To go back to a new local number, choose it above: everything you filled in is kept.</Note>
      </Section>
    );
  }
  return (
    <Section title={route === "port_existing" ? "Bring a number you already have" : "Use a toll-free number"} lead="This is an assisted request. Selestial reviews it and tells you exactly what's needed next.">
      {route === "port_existing" ? (
        <Note tone="warning">
          Moving a number is called porting. Your current carrier sets the date, which isn&apos;t guaranteed, and calls and texts can be interrupted for a while on the day. You&apos;ll need the account holder&apos;s name, the account number and PIN from your current carrier, and a recent bill. Nothing is moved until you sign a separate authorization.
        </Note>
      ) : (
        <Note>Toll-free numbers (800, 888 and others) are verified by the carriers separately from local-number registration, usually in one to two weeks. Your business details and permission wording here are reused; carriers also need to see how people opt in.</Note>
      )}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => ask({ companyId, route, ...(route === "port_existing" ? { phoneNumber: phone, acknowledgement: data.catalog.portWording } : {}), carrier: carrier || undefined, words: words || undefined }));
        }}
      >
        {route === "port_existing" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="The number to bring">
              <TextInput value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" required />
            </Field>
            <Field label="Current carrier (optional)">
              <TextInput value={carrier} onChange={(event) => setCarrier(event.target.value)} />
            </Field>
          </div>
        ) : null}
        <Field label="Anything Selestial should know (optional)">
          <TextArea rows={2} value={words} onChange={(event) => setWords(event.target.value)} maxLength={1000} />
        </Field>
        {route === "port_existing" ? (
          <label className="flex items-start gap-2 text-xs text-strong">
            <Checkbox checked={accepted} onCheckedChange={setAccepted} className="mt-0.5" />
            <span>{data.catalog.portWording}</span>
          </label>
        ) : null}
        <FormError message={error} />
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={route === "port_existing" && !accepted}>
            Send request to Selestial
          </Button>
        </div>
      </form>
    </Section>
  );
}

function LocalNumber() {
  const { view, companyId, run, locked } = useSetup();
  const startSearch = useMutation(api.texting.searchNumbersFor);
  const choose = useMutation(api.textingSetup.chooseNumber);
  const [areaCode, setAreaCode] = useState(() => (view.setup.business.supportPhone ?? "").replace(/\D/g, "").replace(/^1/, "").slice(0, 3));
  const [searchId, setSearchId] = useState<Id<"numberSearches"> | null>(view.setup.number?.searchId ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const results = useQuery(api.texting.search, searchId ? { companyId, searchId } : "skip");
  const chosen = view.setup.number;
  const monthly = view.charges.rows.find((row) => row.key === "number")?.amount ?? "";
  const needsNumber = view.request?.needs?.kind === "number";

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    try {
      setSearchId(await startSearch({ companyId, areaCode }));
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message.replace(/^.*Uncaught \w+Error: /, "") : "The search didn't start.");
    }
  }

  return (
    <>
      {needsNumber ? <Note tone="warning">{view.request?.needs?.words}</Note> : null}

      {chosen ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-500 bg-brand-500/5 px-4 py-3">
          <Phone className="size-5 text-brand-300" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold tracking-tight whitespace-nowrap text-strong tabular-nums">{formatPhone(chosen.phoneNumber)}</p>
            <p className="text-xs text-muted-foreground">{[placeName(chosen.locality), chosen.region].filter(Boolean).join(", ") || "United States"} · your choice</p>
          </div>
          <Capabilities sms={chosen.sms} mms={chosen.mms} voice={chosen.voice} />
        </div>
      ) : null}

      <Section title={chosen ? "Choose a different number" : "Find a number"} lead="US local numbers only.">
        <form onSubmit={(event) => void search(event)} className="flex flex-wrap items-end gap-2">
          <Field label="Area code" hint="Three digits, for example 512." className="w-40">
            <TextInput value={areaCode} onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" autoComplete="off" />
          </Field>
          <Button type="submit" variant="primary" disabled={areaCode.length !== 3 || (locked && !needsNumber)}>
            <Search aria-hidden />
            Search
          </Button>
        </form>
        {problem ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {problem}
          </p>
        ) : null}

        {searchId && results === undefined ? (
          <div className="grid gap-2 sm:grid-cols-2" aria-busy="true" aria-label="Searching">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
        ) : results?.status === "pending" ? (
          <div className="grid gap-2 sm:grid-cols-2" aria-busy="true" aria-label="Searching">
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
        ) : results?.status === "failed" ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            The search didn&apos;t work right now. Try again in a minute.
          </p>
        ) : results ? (
          results.results.length === 0 ? (
            <Note>No numbers can be offered in {results.areaCode} right now. Try a nearby area code; numbers come and go through the day.</Note>
          ) : (
            <div className="grid gap-2">
              {results.nearbyRegion ? <Note>None were available in {results.areaCode}, so these are elsewhere in {results.nearbyRegion}.</Note> : null}
              <ul className="grid gap-2 sm:grid-cols-2" aria-label="Available numbers">
                {results.results.map((row) => {
                  const selected = chosen?.phoneNumber === row.phoneNumber;
                  const features = row.features ?? ["sms"];
                  return (
                    <li key={row.phoneNumber}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={locked && !needsNumber}
                        onClick={() => void run((revision) => choose({ companyId, revision, searchId: searchId!, phoneNumber: row.phoneNumber }))}
                        className={cn("grid w-full gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-brand-500 motion-reduce:transition-none", selected ? "border-brand-500 bg-brand-500/5" : "border-border bg-card hover:border-brand-500/40")}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-base font-semibold text-strong tabular-nums">{formatPhone(row.phoneNumber)}</span>
                          {selected ? <Check className="size-4 text-brand-300" aria-label="Chosen" /> : null}
                        </span>
                        <span className="text-xs text-muted-foreground">{[placeName(row.locality), row.region].filter(Boolean).join(", ") || "United States"}</span>
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <Capabilities sms={features.includes("sms")} mms={features.includes("mms")} voice={features.includes("voice")} />
                          <span className="text-xs font-medium text-strong">{monthly}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        ) : null}
      </Section>

      <Note>Choosing a number doesn&apos;t hold it. It&apos;s bought only after the carriers approve your registration, and checked again first. If it&apos;s been taken by then, Selestial asks you to choose another instead of picking one for you.</Note>
    </>
  );
}

function Capabilities({ sms, mms, voice }: { sms: boolean; mms: boolean; voice: boolean }) {
  return (
    <span className="flex flex-wrap gap-1" aria-label="What this number can do">
      {sms ? <Badge variant="outline">Texts</Badge> : null}
      {mms ? <Badge variant="outline">Pictures</Badge> : null}
      {voice ? <Badge variant="outline">Calls</Badge> : null}
    </span>
  );
}
