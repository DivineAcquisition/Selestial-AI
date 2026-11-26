"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Action, Loading, Notice, problemWords } from "@/components/cleaner/shell";

import type { Field, Section } from "../../../convex/lib/recruiter/form";
import { ApplicationForm, ApplyFrame } from "./form/application-form";
import type { Answer, Answers } from "./form/fields";

const CLOSED: Record<string, { tone: "neutral" | "warn" | "good"; title: string; body: string }> = {
  submitted: { tone: "good", title: "Your application is in", body: "Thank you. The hiring team will review what you sent. If they need anything else, or want to arrange a conversation, they will email you." },
  withdrawn: { tone: "neutral", title: "You withdrew this application", body: "Nothing more will be sent to you about it." },
  closed: { tone: "neutral", title: "This application is closed", body: "If you think this is a mistake, reply to the email that brought you here." },
  role_closed: { tone: "neutral", title: "This role is not taking applications right now", body: "Reply to the email that brought you here if you have questions." },
  expired: { tone: "warn", title: "This link has expired", body: "Reply to the email that brought you here and ask for a new link. What you saved is kept." },
  revoked: { tone: "neutral", title: "This link is no longer active", body: "Use the newest link you were sent, or reply to the email that brought you here." },
};

/**
 * The application, on the applicant's private link. Loading it only reads. What the applicant enters is
 * saved to the server at each step and whenever they ask, so they can leave and come back with the same
 * link on any device. Submitting is its own button on the review step, behind a confirmation.
 */
export function ApplyPage({ token }: { token: string }) {
  const data = useQuery(api.applicantPages.application, { token });
  const save = useMutation(api.applicantPages.saveDraft);
  const submit = useMutation(api.applicantPages.submit);
  const withdraw = useMutation(api.applicantPages.withdraw);
  const uploadUrl = useMutation(api.applicantPages.fileUploadUrl);
  const attach = useMutation(api.applicantPages.attachFile);
  const removeFile = useMutation(api.applicantPages.removeFile);

  const [answers, setAnswers] = useState<Answers | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const serverAnswers = data?.form?.answers;
  useEffect(() => {
    // The saved draft is taken from the server once, when the page first has it. After that the page's own copy is the one being edited.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (serverAnswers && answers === null) setAnswers(serverAnswers as Answers);
  }, [serverAnswers, answers]);

  if (data === undefined) return <Loading what="your application" />;
  const look = data.look;
  const frame = { accentColor: look.accentColor, logoUrl: look.logoUrl, companyName: data.company, title: `${data.role} application` };
  const form = data.form;
  if (data.state !== "open" || !form) {
    const closed = CLOSED[data.state] ?? CLOSED.closed;
    const submitted = data.state === "submitted";
    return (
      <ApplyFrame look={frame}>
        <Notice tone={closed.tone} title={submitted ? look.copy.thankYouTitle : closed.title} testId={`state-${data.state}`}>
          {submitted ? `${look.copy.thankYouBody || closed.body} Sending an application does not guarantee an interview or a job.` : closed.body}
        </Notice>
      </ApplyFrame>
    );
  }
  if (answers === null) return <Loading what="your application" />;

  const fields = form.fields as Field[];
  const run = async (name: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(name);
    setProblem(null);
    setSaved(false);
    try {
      await action();
      return true;
    } catch (error) {
      setProblem(problemWords(error));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const set = (key: string, value: Answer | undefined) => {
    setSaved(false);
    setAnswers((before) => {
      const next = { ...(before ?? {}) };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const upload = (field: Field, file: File) =>
    void run("upload", async () => {
      const url = await uploadUrl({ token });
      const sent = await fetch(url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!sent.ok) throw new Error("upload failed");
      const { storageId } = (await sent.json()) as { storageId: Id<"_storage"> };
      // The general box on the review step is the older resume-or-supporting upload; a file question names itself.
      const general = field.section === "review";
      await attach({ token, storageId, kind: general && form.files.length > 0 ? "supporting" : "resume", ...(general ? {} : { field: field.key }), fileName: file.name, clientKey: `${file.name}-${file.size}-${file.lastModified}`.slice(0, 80).padEnd(8, "0") });
    });

  return (
    <ApplyFrame look={{ ...frame, title: look.copy.title || frame.title }}>
      <ApplicationForm
        look={look}
        greeting={data.firstName}
        about={form.about}
        fields={fields}
        sections={form.sections as Section[]}
        answers={answers}
        onAnswer={set}
        files={{ files: form.files.map((file) => ({ attachmentId: file.attachmentId, fileName: file.fileName, field: file.field })), canAdd: form.files.length < form.maxFiles, busy: busy === "upload" || busy === "remove", onUpload: upload, onRemove: (attachmentId) => void run("remove", async () => void (await removeFile({ token, attachmentId: attachmentId as Id<"applicantAttachments"> }))) }}
        generalFiles={!fields.some((field) => field.kind === "file")}
        attestation={form.attestation}
        onContinue={() => run("save", async () => void (await save({ token, answers })))}
        onSaveLater={() => void run("save", async () => void (await save({ token, answers }))).then((ok) => setSaved(ok))}
        onSubmit={(attested) => void run("submit", async () => void (await submit({ token, answers, attested })))}
        busy={busy}
        problem={problem}
        saved={saved}
        footer={
          confirmWithdraw ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
              <p className="text-sm font-medium">Withdraw your application? We will not contact you about it again.</p>
              <div className="flex gap-2">
                <Action kind="secondary" disabled={busy !== null} onPress={() => setConfirmWithdraw(false)}>
                  Keep it
                </Action>
                <Action kind="danger" busy={busy === "withdraw"} disabled={busy !== null} onPress={() => void run("withdraw", async () => void (await withdraw({ token })))} testId="confirm-withdraw">
                  Yes, withdraw
                </Action>
              </div>
            </div>
          ) : (
            <button type="button" className="self-center py-2 text-sm text-muted-foreground underline" onClick={() => setConfirmWithdraw(true)} data-testid="withdraw">
              I no longer want to apply
            </button>
          )
        }
      />
    </ApplyFrame>
  );
}
