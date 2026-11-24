"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, useRun } from "@/components/app/form";
import { SwitchButton } from "@/components/app/services/shared";
import { Panel } from "@/components/app/shell";
import { Phone } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PhoneInput, phoneProblem } from "@/components/ui/fields";
import { Input } from "@/components/ui/input";

import { api } from "../../../../convex/_generated/api";

type Category = (typeof api.notifications.mine)["_returnType"]["categories"][number];

function TextRow({ row, busy, onChange }: { row: Category; busy: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <p id={id} className="text-sm font-medium text-strong">
          {row.label}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{row.about}</p>
      </div>
      <SwitchButton checked={row.text} onChange={onChange} disabled={busy} labelledBy={id} className="mt-0.5" />
    </li>
  );
}

/**
 * Selestial's texts to this person (not texts the company sends its customers): their own phone, confirmed
 * with a code, the kinds of notice they want by text, and when texts wait until morning. Selestial pays for
 * these; they never use the company's messaging balance.
 */
export function TextPreferences({ categories, quiet }: { categories: Category[]; quiet: { start: string; end: string } }) {
  const { companyId } = useCompany();
  const phone = useQuery(api.myPhone.mine, {});
  const start = useMutation(api.myPhone.start);
  const confirm = useMutation(api.myPhone.confirm);
  const remove = useMutation(api.myPhone.remove);
  const setText = useMutation(api.notifications.setText);
  const setQuiet = useMutation(api.notifications.setTextQuiet);
  const { busy, error, run } = useRun();
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [quietStart, setQuietStart] = useState(quiet.start);
  const [quietEnd, setQuietEnd] = useState(quiet.end);
  const [saved, setSaved] = useState<string | null>(null);
  const textable = categories.filter((row) => row.textable);

  if (phone === undefined) return null;
  const say = (words: string) => {
    setSaved(words);
    window.setTimeout(() => setSaved(null), 4000);
  };

  return (
    <Panel flush title="Text me about">
      <div className="grid gap-4 border-b border-border px-4 py-4 sm:px-5">
        <p className="text-sm text-muted-foreground">
          <Phone aria-hidden className="mr-1.5 inline size-4 align-[-3px]" />
          Texts from Selestial to you, for things that need you to act. They&rsquo;re separate from texts your company sends its customers, and they never use your company&rsquo;s messaging balance.
        </p>

        {!phone.available ? (
          <p className="text-sm text-muted-foreground">Texts to you aren&rsquo;t available yet. Email notices keep working as set above.</p>
        ) : phone.phoneLast4 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-strong">
              Texts go to your phone ending <span className="font-medium tabular-nums">{phone.phoneLast4}</span>. The same phone is used in every company you belong to.
            </p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => (await remove({}), say("Your phone was removed. No more texts.")))}>
              Remove phone
            </Button>
          </div>
        ) : phone.pending ? (
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await confirm({ code });
                setCode("");
                say("Phone confirmed.");
              });
            }}
          >
            <Field label={`Code sent to the phone ending ${phone.pending.last4}`} hint="It expires in 10 minutes.">
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" loading={busy} disabled={code.length !== 6}>
                Confirm
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => (await remove({}), setNumber("")))}>
                Use a different number
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await start({ phone: number });
                say("Code sent.");
              });
            }}
          >
            <Field label="Your mobile number" hint="US numbers only. We'll text a code to confirm it's yours.">
              <PhoneInput value={number} onChange={setNumber} />
            </Field>
            <Button type="submit" size="sm" loading={busy} disabled={!number.trim() || phoneProblem(number) !== null}>
              Text me a code
            </Button>
          </form>
        )}
      </div>

      {phone.phoneLast4 ? (
        <>
          <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground sm:px-5">Each switch saves as soon as you change it. Other notices come by email only.</p>
          <ul className="divide-y divide-border">
            {textable.map((row) => (
              <TextRow key={row.category} row={row} busy={busy} onChange={(on) => void run(() => setText({ companyId, category: row.category, on }))} />
            ))}
          </ul>
          <form
            className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-4 sm:px-5"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await setQuiet({ companyId, start: quietStart, end: quietEnd });
                say("Quiet hours saved.");
              });
            }}
          >
            <Field label="No texts from" hint="Urgent ones still come.">
              <Input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} />
            </Field>
            <Field label="Until">
              <Input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} />
            </Field>
            <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={quietStart === quiet.start && quietEnd === quiet.end}>
              Save quiet hours
            </Button>
          </form>
        </>
      ) : null}

      <div className="px-4 pb-3 sm:px-5" aria-live="polite">
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : saved ? (
          <p className="text-sm text-emerald-700">{saved}</p>
        ) : null}
      </div>
    </Panel>
  );
}
