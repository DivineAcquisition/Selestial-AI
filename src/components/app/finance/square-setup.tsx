"use client";

/**
 * Finance › Payments setup: the company's own Square account (docs/finance/square.md), and which provider
 * takes new payment requests. Square's authorization happens on Square's site; coming back, the Owner
 * confirms the business Square answered for before anything is connected, then chooses the location
 * payments are taken at.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { IntegrationMark } from "@/components/app/integration-mark";
import { Modal } from "@/components/app/modal";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/selection";
import { moment } from "@/lib/app/finance";
import { cn } from "@/lib/utils";

import { api } from "../../../../convex/_generated/api";
import { Notice, Section } from "./kit";

type Settings = FunctionReturnType<typeof api.finance.settings>;
type Square = Settings["square"];
type Provider = "stripe" | "square";

/** The words a person reads for each state, matching Connected apps. */
export const SQUARE_LOOK: Record<Square["state"], { word: string; dot: string }> = {
  unavailable: { word: "Unavailable", dot: "bg-muted-foreground/50" },
  not_connected: { word: "Not connected", dot: "bg-muted-foreground/50" },
  needs_location: { word: "Setup incomplete", dot: "bg-warning" },
  ready: { word: "Ready", dot: "bg-success" },
  needs_reconnect: { word: "Needs reconnection", dot: "bg-destructive" },
  disconnected: { word: "Not connected", dot: "bg-muted-foreground/50" },
};

/** Which provider takes new payment requests. Changing it shows exactly what happens first. */
export function ProviderChoice({ data }: { data: Settings }) {
  const [asking, setAsking] = useState<Provider | null>(null);
  const current = data.settings.paymentProvider;
  const choices: { id: Provider; name: string; ready: boolean; detail: string }[] = [
    { id: "stripe", name: "Stripe", ready: data.stripe.canPayByCard, detail: data.stripe.canPayByCard ? "Card and bank payments on your pay page" : "Not ready: connect Stripe below" },
    { id: "square", name: "Square", ready: data.square.canPay, detail: data.square.canPay ? `Square checkout${data.square.location ? ` · ${data.square.location.name}` : ""}` : data.square.state === "needs_location" ? "Not ready: choose a location below" : "Not ready: connect Square below" },
  ];
  const groupLabel = useId();
  return (
    <Section title="New payment requests" description="Which provider your customers pay through on their pay links">
      <div className="grid gap-3 px-4 pb-4 sm:px-5 sm:pb-5">
        <div role="radiogroup" aria-labelledby={groupLabel} className="grid gap-2 sm:grid-cols-2">
          <span id={groupLabel} className="sr-only">
            Provider for new payment requests
          </span>
          {choices.map((choice) => {
            const on = current === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => (on ? undefined : setAsking(choice.id))}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-brand-500",
                  on ? "border-brand-500/50 bg-brand-500/8" : "border-border hover:bg-muted/50",
                )}
              >
                <IntegrationMark id={choice.id} size="md" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-sm font-medium text-strong">
                    {choice.name}
                    {on ? <span className="ml-1.5 text-xs font-normal text-strong/70">· in use</span> : null}
                  </span>
                  <span className={cn("text-xs", choice.ready ? (on ? "text-strong/70" : "text-muted-foreground") : "text-warning-foreground")}>{choice.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Payments already made keep their provider, and their refunds go back the same way. Selestial&apos;s own plan is billed separately.</p>
      </div>
      <Modal open={asking !== null} onClose={() => setAsking(null)} title={`Take new payments through ${asking === "square" ? "Square" : "Stripe"}?`} description="Nothing changes until you confirm.">
        {asking ? <SwitchProvider provider={asking} onDone={() => setAsking(null)} /> : null}
      </Modal>
    </Section>
  );
}

function SwitchProvider({ provider, onDone }: { provider: Provider; onDone: () => void }) {
  const { companyId } = useCompany();
  const preview = useQuery(api.finance.providerPreview, { companyId, provider });
  const save = useMutation(api.finance.setPaymentProvider);
  const { busy, error, run } = useRun();
  if (!preview) return <p className="text-sm text-muted-foreground">Checking what this changes…</p>;
  return (
    <div className="grid gap-4">
      <ul className="grid list-disc gap-1.5 pl-5 text-sm text-strong">
        {preview.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {preview.blocked ? <Notice tone="warning" title="Not yet">{preview.blocked}</Notice> : null}
      <FormError message={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={busy || Boolean(preview.blocked)} onClick={() => run(async () => { await save({ companyId, provider, bindsTo: preview.bindsTo }); onDone(); })}>
          {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
          Switch to {provider === "square" ? "Square" : "Stripe"}
        </Button>
      </div>
    </div>
  );
}

/** The company's Square account: connect, confirm the business, choose a location, reconnect or disconnect. */
export function SquareCard({ data }: { data: Settings }) {
  const { companyId, timezone } = useCompany();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const start = useMutation(api.financeSquare.startConnect);
  const refresh = useMutation(api.financeSquare.refreshLocations);
  const { busy, error, run } = useRun();
  const [disconnecting, setDisconnecting] = useState(false);
  const square = data.square;
  const look = SQUARE_LOOK[square.state];
  const back = params.get("square");
  const confirmToken = back === "confirm" ? params.get("t") : null;
  const clear = () => router.replace(pathname, { scroll: false });

  const connect = () =>
    run(async () => {
      const { url } = await start({ companyId, returnTo: window.location.origin });
      window.location.assign(url);
      // The page stays busy until Square opens.
      await new Promise(() => undefined);
    });

  return (
    <Section title="Square" description="Through your own Square account" className="scroll-mt-20">
      <div id="square" className="grid gap-4 px-4 pb-4 sm:px-5 sm:pb-5">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3.5">
          <IntegrationMark id="square" size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-strong">{square.businessName ?? "Square"}</p>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <span className={cn("mt-1 size-2 shrink-0 rounded-full", look.dot)} aria-hidden />
              <span>
                {look.word}
                {square.sandbox ? " · Sandbox (test payments only)" : ""}
                {square.checkedAt ? ` · checked ${moment(square.checkedAt, timezone, true)}` : ""}
              </span>
            </p>
          </div>
          {square.state === "ready" || square.state === "needs_location" ? (
            <Button size="icon-sm" variant="ghost" aria-label="Check with Square again" disabled={busy} onClick={() => run(() => refresh({ companyId }))}>
              <RefreshCw aria-hidden />
            </Button>
          ) : null}
        </div>

        {back === "declined" ? <Notice tone="info" title="Square wasn't connected">You chose not to allow Selestial in Square. Nothing changed.</Notice> : null}
        {back === "expired" ? <Notice tone="warning" title="That authorization expired">Square took longer than ten minutes to come back. Start again; nothing was connected.</Notice> : null}
        {back === "failed" ? <Notice tone="warning" title="Square didn't finish connecting">Selestial couldn&apos;t complete the authorization with Square. Nothing was connected. Try again.</Notice> : null}

        {square.state === "unavailable" ? (
          <Notice tone="info" title="Square isn't available on Selestial yet">
            {square.blockers[0] ?? "Selestial's team is finishing the Square setup."} You can still take payments through Stripe and record payments you receive.
          </Notice>
        ) : square.state === "needs_reconnect" ? (
          <Notice tone="danger" title="Reconnect Square to accept new payments">
            {square.problem ?? "Square stopped accepting Selestial's access to your account."}
            {square.openLinksAtLoss ? ` ${square.openLinksAtLoss} checkout${square.openLinksAtLoss === 1 ? " was" : "s were"} still open; payments made on them appear here after you reconnect.` : ""}
          </Notice>
        ) : square.state === "ready" ? (
          <ul className="grid gap-2 text-sm">
            <li className="flex items-start gap-2 text-strong">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden />
              Online card, Apple Pay and Google Pay payments at {square.location?.name}, in US dollars
            </li>
            {data.settings.paymentProvider !== "square" ? <li className="text-xs text-muted-foreground">Stripe still takes new payment requests. Choose Square above to switch.</li> : null}
            {!square.webhookReady ? <li className="text-xs text-muted-foreground">Payments are confirmed by checking Square every few minutes until Selestial&apos;s Square notifications are switched on.</li> : null}
          </ul>
        ) : square.state === "needs_location" ? (
          <LocationPicker square={square} />
        ) : (
          <p className="text-sm text-muted-foreground">Connect your own Square account. Customers pay through Square&apos;s secure checkout and the money goes to your Square account: Selestial never holds it and takes no fee. Square charges its usual processing fee.</p>
        )}

        {square.state === "ready" && square.locations.filter((l) => l.eligible).length > 1 ? <LocationPicker square={square} compact /> : null}

        {square.state === "not_connected" || square.state === "disconnected" || square.state === "needs_reconnect" ? (
          <Button variant="default" disabled={busy || !square.canConnect} onClick={connect}>
            {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <ExternalLink aria-hidden />}
            {busy ? "Opening Square…" : square.state === "needs_reconnect" ? "Reconnect Square" : "Connect Square"}
          </Button>
        ) : null}
        {square.state === "needs_reconnect" && !square.canConnect && square.blockers[0] ? <p className="text-xs text-muted-foreground">{square.blockers[0]}</p> : null}
        <FormError message={error} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Card details are entered on Square&apos;s checkout, never in Selestial. Payouts, disputes and your bank stay in your Square Dashboard.
          </p>
          {square.state !== "unavailable" && square.state !== "not_connected" && square.state !== "disconnected" ? (
            <Button variant="ghost" size="sm" onClick={() => setDisconnecting(true)}>
              Disconnect
            </Button>
          ) : null}
        </div>
        <SupportDetails square={square} />
      </div>
      <Modal open={confirmToken !== null} onClose={clear} title="Connect this Square business?" description="Square answered for the business below. Nothing is connected until you confirm.">
        {confirmToken ? <ConfirmBusiness token={confirmToken} onDone={clear} /> : null}
      </Modal>
      <Modal open={disconnecting} onClose={() => setDisconnecting(false)} title="Disconnect Square?" description="Nothing changes until you confirm.">
        {disconnecting ? <Disconnect onDone={() => setDisconnecting(false)} /> : null}
      </Modal>
    </Section>
  );
}

function LocationPicker({ square, compact }: { square: Square; compact?: boolean }) {
  const { companyId } = useCompany();
  const choose = useMutation(api.financeSquare.chooseLocation);
  const { busy, error, run } = useRun();
  const label = useId();
  const eligible = square.locations.filter((l) => l.eligible);
  const [chosen, setPicked] = useState<string>(square.location?.id ?? "");
  // With one eligible location it is preselected; the Owner still confirms it.
  const picked = chosen || (eligible.length === 1 ? eligible[0].id : "");
  const blocked = square.locations.filter((l) => !l.eligible);
  return (
    <div className="grid gap-3">
      {!compact ? (
        <Notice tone="warning" title="Choose a location for payments">
          {square.locationProblem ?? "Pick the Square location your customers' online payments go to. Only a location Square has set up for card payments in US dollars can be chosen."}
        </Notice>
      ) : null}
      {square.locations.length === 0 ? (
        <p className="text-sm text-muted-foreground">Reading your locations from Square…</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-[14rem] flex-1 gap-1">
            <span id={label} className="text-xs font-medium text-muted-foreground">
              {compact ? "Location for payments" : "Location"}
            </span>
            <Select aria-labelledby={label} value={picked} onValueChange={(next) => setPicked(next ?? "")} options={eligible.map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a location" />
          </div>
          <Button disabled={busy || !picked || picked === square.location?.id} onClick={() => run(() => choose({ companyId, locationId: picked }))}>
            {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
            {square.location ? "Use this location" : "Choose location"}
          </Button>
        </div>
      )}
      {blocked.length ? (
        <ul className="grid gap-1 text-xs text-muted-foreground">
          {blocked.map((l) => (
            <li key={l.id}>
              <span className="font-medium text-strong">{l.name}</span> can&apos;t be used: {l.why}
            </li>
          ))}
        </ul>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

function ConfirmBusiness({ token, onDone }: { token: string; onDone: () => void }) {
  const { companyId } = useCompany();
  const pending = useQuery(api.financeSquare.pendingConnect, { companyId, token });
  const confirm = useMutation(api.financeSquare.confirmConnect);
  const cancel = useMutation(api.financeSquare.cancelConnect);
  const { busy, error, run } = useRun();
  const [result, setResult] = useState<string | null>(null);
  if (pending === undefined) return <p className="text-sm text-muted-foreground">Reading what Square answered…</p>;
  if (pending === null) return <Notice tone="warning" title="This authorization isn't waiting any more">Start connecting Square again. Nothing was connected.</Notice>;
  if (result) {
    const words: Record<string, { tone: "success" | "warning"; title: string; body: string }> = {
      connected: { tone: "success", title: "Square is connected", body: "Choose the location payments go to, and it's ready." },
      reconnected: { tone: "success", title: "Square is reconnected", body: "Payments that were waiting are being checked with Square now." },
      taken: { tone: "warning", title: "This Square account is already connected to another business on Selestial", body: "It wasn't connected here, and the other business keeps its connection. Use a different Square account, or contact Selestial if this is wrong." },
      other_account: { tone: "warning", title: "A different Square account is already connected", body: "Disconnect the current Square account first, then connect this one. Nothing was changed." },
      expired: { tone: "warning", title: "This authorization expired", body: "Start connecting Square again. Nothing was connected." },
    };
    const w = words[result] ?? words.expired;
    return (
      <div className="grid gap-4">
        <Notice tone={w.tone} title={w.title}>
          {w.body}
        </Notice>
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 rounded-xl border border-border bg-muted/30 p-3.5 text-sm">
        <dt className="text-muted-foreground">Business</dt>
        <dd className="font-medium text-strong">{pending.businessName ?? "Name not shared by Square"}</dd>
        {pending.country ? (
          <>
            <dt className="text-muted-foreground">Country</dt>
            <dd className="text-strong">{pending.country}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Square</dt>
        <dd className="text-strong">{pending.environment === "sandbox" ? "Sandbox (test payments only)" : "Live account"}</dd>
      </dl>
      {pending.takenElsewhere ? <Notice tone="warning" title="Already connected to another business">This Square account is connected to another business on Selestial, so it can&apos;t be connected here.</Notice> : null}
      {pending.otherAccountConnected ? <Notice tone="warning" title="Another Square account is connected">Disconnect {pending.otherAccountConnected} first, then connect this one.</Notice> : null}
      {pending.expired ? <Notice tone="warning" title="This authorization expired">Start connecting Square again.</Notice> : null}
      {!pending.takenElsewhere && !pending.otherAccountConnected && !pending.expired ? <p className="text-sm text-muted-foreground">{pending.reconnect ? "This is the Square account already connected. Confirming restores Selestial's access to it." : "Selestial will read this business and its locations, create checkout links for your invoices, read their payments and send refunds you confirm. Nothing else."}</p> : null}
      <FormError message={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await cancel({ companyId, token }); onDone(); })}>
          Not this business
        </Button>
        <Button disabled={busy || pending.takenElsewhere || Boolean(pending.otherAccountConnected) || pending.expired} onClick={() => run(async () => setResult((await confirm({ companyId, token })).result))}>
          {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
          {pending.reconnect ? "Reconnect" : "Connect this business"}
        </Button>
      </div>
    </div>
  );
}

function Disconnect({ onDone }: { onDone: () => void }) {
  const { companyId } = useCompany();
  const preview = useQuery(api.financeSquare.disconnectPreview, { companyId });
  const go = useMutation(api.financeSquare.disconnect);
  const { busy, error, run } = useRun();
  if (preview === undefined) return <p className="text-sm text-muted-foreground">Checking what this changes…</p>;
  if (preview === null) return <p className="text-sm text-muted-foreground">Square isn&apos;t connected.</p>;
  return (
    <div className="grid gap-4">
      <ul className="grid list-disc gap-1.5 pl-5 text-sm text-strong">
        {preview.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {preview.blocked ? <Notice tone="warning" title="Not yet">{preview.blocked}</Notice> : null}
      <FormError message={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Keep connected
        </Button>
        <Button variant="destructive" disabled={busy || Boolean(preview.blocked)} onClick={() => run(async () => { await go({ companyId, bindsTo: preview.bindsTo }); onDone(); })}>
          {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
          Disconnect Square
        </Button>
      </div>
    </div>
  );
}

/** Technical references for Selestial's support, folded away. No secret is ever here. */
function SupportDetails({ square }: { square: Square }) {
  if (square.state === "not_connected" && !square.blockerSettings.length) return null;
  return (
    <details className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-strong">Support details</summary>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Environment</dt>
        <dd>{square.environment ?? "Not set"}</dd>
        {square.merchantId ? (
          <>
            <dt>Merchant ID</dt>
            <dd>{square.merchantId}</dd>
          </>
        ) : null}
        {square.location ? (
          <>
            <dt>Location ID</dt>
            <dd>{square.location.id}</dd>
          </>
        ) : null}
        <dt>Notifications</dt>
        <dd>{square.webhookReady ? "On" : "Off: payments are checked every few minutes"}</dd>
        {square.blockerSettings.length ? (
          <>
            <dt>Needs setting</dt>
            <dd>{square.blockerSettings.join(", ")}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}
