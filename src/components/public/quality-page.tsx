"use client";

/**
 * The private page a cleaner or customer opens from a Quality request: add the missing photos, answer a
 * focused question, or give an account of what happened, and add to it later.
 *
 * Opening the page changes nothing. It names the visit by day and town only, and never repeats what anyone
 * said about it. Nothing has been decided: the page says so, and a later answer is kept beside the first,
 * never in place of it. Typing is kept on the phone until it is sent.
 */
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";

import { Action, Card, linkKey, Loading, Notice, Page, Problem, problemWords, Row, TextBox, useDraft } from "@/components/cleaner/shell";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type View = NonNullable<FunctionReturnType<typeof api.qualityLinks.view>>;
type Result = { ok: true; words: string } | { ok: false; why: string };

const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const TITLES: Record<View["purpose"], string> = {
  missing_evidence: "A few photos from your visit",
  question: "A quick question about your visit",
  statement: "Your account of the visit",
  supplement: "Add to your account",
  correction_outcome: "How the return visit went",
};

function Upload({ token, evidenceId, label, accept, onDone, onProblem }: { token: string; evidenceId?: string; label: string; accept: string; onDone: (words: string) => void; onProblem: (why: string) => void }) {
  const uploadUrl = useMutation(api.qualityLinks.uploadUrl);
  const attach = useMutation(api.qualityLinks.attachFile);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function send(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files).slice(0, 10)) {
        const target = await uploadUrl({ token });
        if (!target.ok) {
          onProblem(target.why);
          return;
        }
        const response = await fetch(target.url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (!response.ok) {
          onProblem("The upload did not finish. Check your connection and try again.");
          return;
        }
        const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
        const result: Result = await attach({ token, storageId, name: file.name, contentType: file.type, clientKey: newKey(), ...(evidenceId ? { evidenceId } : {}) });
        if (!result.ok) {
          onProblem(result.why);
          return;
        }
        onDone(result.words);
      }
    } catch (caught) {
      onProblem(problemWords(caught));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <>
      <input ref={input} type="file" accept={accept} multiple className="sr-only" aria-label={label} onChange={(e) => void send(e.target.files)} />
      <Action kind="secondary" busy={busy} onPress={() => input.current?.click()}>{label}</Action>
    </>
  );
}

function Answer({ token, view }: { token: string; view: View }) {
  const save = useMutation(api.qualityLinks.saveDraft);
  const submit = useMutation(api.qualityLinks.submit);
  const remove = useMutation(api.qualityLinks.removeFile);
  const base = linkKey(token);
  const drafts = view.questions.map((q) => q.id);
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries((view.draft?.answers ?? []).map((a) => [a.questionId, a.text])));
  const [account, setAccount, clearAccount] = useDraft(`${base}.account`);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [clientKey] = useState(newKey);
  const accountOpen = view.purpose === "statement" || view.purpose === "supplement";
  const accountText = account || view.draft?.account || "";
  const canUpload = view.allowed.includes("upload");
  const list = () => drafts.map((id) => ({ questionId: id, text: answers[id] ?? "" })).filter((a) => a.text.trim());
  async function run(work: () => Promise<Result>, after?: () => void) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await work();
      if (result.ok) {
        after?.();
        setNote(result.words);
      } else setProblem(result.why);
    } catch (caught) {
      setProblem(problemWords(caught));
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <Notice tone="good" title="Sent" testId="sent">
        {done}
      </Notice>
    );
  }
  return (
    <>
      {view.evidence.length ? (
        <Card title="Photos asked for">
          <ul className="flex flex-col gap-3">
            {view.evidence.map((e) => (
              <li key={e.id} className="flex flex-col gap-2">
                <Row label={e.label}>{e.photoKind ? `${e.uploaded} added` : ""}</Row>
                {canUpload ? <Upload token={token} evidenceId={e.id} label={e.photoKind ? "Add photos" : "Add a file"} accept={e.photoKind ? "image/*" : "image/*,application/pdf,video/mp4,video/quicktime"} onDone={setNote} onProblem={setProblem} /> : null}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Each photo shows when it was uploaded. When it was taken is not recorded.</p>
        </Card>
      ) : null}
      {view.questions.length ? (
        <Card title={view.questions.length === 1 ? "The question" : "The questions"}>
          {view.questions.map((q) => (
            <TextBox key={q.id} label={q.text} value={answers[q.id] ?? ""} onChange={(text) => setAnswers((prev) => ({ ...prev, [q.id]: text }))} testId={`answer-${q.id}`} />
          ))}
        </Card>
      ) : null}
      {accountOpen ? (
        <Card title={view.purpose === "supplement" ? "What you would like to add" : "In your own words"}>
          <TextBox label="What happened at the visit, as you remember it" value={accountText} onChange={setAccount} testId="account" />
        </Card>
      ) : null}
      {canUpload && !view.evidence.some((e) => e.photoKind) ? (
        <Card title="Anything that helps">
          <p className="text-sm text-muted-foreground">Photos, a PDF or a short video. Optional.</p>
          <Upload token={token} label="Add a file" accept="image/*,application/pdf,video/mp4,video/quicktime" onDone={setNote} onProblem={setProblem} />
        </Card>
      ) : null}
      {view.files.length ? (
        <Card title="Added, not sent yet">
          <ul className="flex flex-col gap-2 text-sm">
            {view.files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3">
                <span className="truncate">{f.name}</span>
                <button type="button" className="text-sm font-medium text-red-600" onClick={() => void run(() => remove({ token, fileId: f.id }))}>Remove</button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {view.verification !== "none" && view.allowed.includes("submit") && (view.questions.length || accountOpen) ? (
        <Card title="Confirm it's you">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{view.verification === "zip" ? "The ZIP code of the property" : "The last 4 digits of your phone number"}</span>
            <input inputMode="numeric" autoComplete="off" maxLength={view.verification === "zip" ? 5 : 4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="min-h-12 rounded-xl border border-border bg-background px-3 text-base" data-testid="code" />
          </label>
        </Card>
      ) : null}
      {note ? <p role="status" className="text-sm text-muted-foreground">{note}</p> : null}
      <Problem message={problem} />
      {view.allowed.includes("submit") ? (
        <Action busy={busy} onPress={() => void run(async () => {
          const result: Result = await submit({ token, answers: list(), ...(accountText.trim() ? { account: accountText } : {}), ...(code ? { code } : {}), clientKey });
          if (result.ok) {
            clearAccount();
            setDone(result.words);
          }
          return result;
        })} testId="submit">
          {view.submitted.length ? "Send what I've added" : "Send"}
        </Action>
      ) : null}
      {view.allowed.includes("save_draft") && (view.questions.length || accountOpen) ? (
        <Action kind="secondary" busy={busy} onPress={() => void run(() => save({ token, answers: list(), ...(accountText.trim() ? { account: accountText } : {}) }))} testId="save">
          Save and finish later
        </Action>
      ) : null}
    </>
  );
}

export function QualityRequestPage({ token }: { token: string }) {
  const view = useQuery(api.qualityLinks.view, { token });
  if (view === undefined) return <Loading what="your page" />;
  if (view === null) {
    return (
      <Page company={null} title="Link not found">
        <Notice tone="bad" title="This link doesn't work" testId="state-invalid">
          Check the link in your message, or ask the office to send a new one.
        </Notice>
      </Page>
    );
  }
  const contact = view.company.phone ? `call ${view.company.phone}` : view.company.email ? `email ${view.company.email}` : `contact ${view.company.name}`;
  if (view.state !== "active") {
    return (
      <Page company={view.company.name} title={view.state === "expired" ? "This link has expired" : "This link is no longer active"}>
        <Notice tone="warn" title={view.state === "expired" ? "This link has expired" : "This link was closed"} testId={`state-${view.state}`}>
          Nothing was changed. If you still want to add something, {contact}.
        </Notice>
      </Page>
    );
  }
  return (
    <Page company={view.company.name} title={TITLES[view.purpose]}>
      <p className="text-sm text-muted-foreground">{view.firstName ? `Hi ${view.firstName}. ` : ""}This page is private to you.</p>
      {view.visit ? (
        <Card title="This is about">
          <Row label="Visit">{view.visit.service}</Row>
          <Row label="When">{view.visit.day}</Row>
          {view.visit.city ? <Row label="Where">{view.visit.city}</Row> : null}
        </Card>
      ) : null}
      {view.note ? <Notice tone="neutral" title="Nothing has been decided">{view.note}</Notice> : null}
      {view.submitted.length ? (
        <Card title="Already sent">
          <ul className="flex flex-col gap-1 text-sm">
            {view.submitted.map((s) => <li key={s.version}>{s.kind === "original" ? "Your answer" : `Addition ${s.version - 1}`}: {s.answers} {s.answers === 1 ? "answer" : "answers"}{s.files ? `, ${s.files} ${s.files === 1 ? "file" : "files"}` : ""}</li>)}
          </ul>
          <p className="text-xs text-muted-foreground">What you sent is kept as you wrote it. Anything you add now is kept alongside it.</p>
        </Card>
      ) : null}
      <Answer token={token} view={view} />
      <p className="text-center text-xs text-muted-foreground">Questions? You can {contact}.</p>
    </Page>
  );
}
