"use client";

/**
 * Recruiter › Application forms: the forms applicants answer, which role uses which, and how applicants
 * get to them: an emailed private link, or the company's public application page. The first visit sets
 * up the full cleaner application, so a new company starts with a working form it can change.
 */
import { Copy as CopyIcon, Envelope, Lightning, Plus, Star } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useCompany } from "@/components/app/company";
import { FormError, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { Notice } from "@/components/app/services/shared";
import { PageHeader, Panel } from "@/components/app/shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { Select, Switch } from "@/components/ui/selection";
import { Skeleton } from "@/components/ui/skeleton";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { FORMS_ROOT } from "./builder";
import { SendApplicationDialog } from "./send-dialog";
import { CopyButton } from "./share";

const LEAD = "Build the application applicants fill in, then send it by email or put it on your website.";

export function FormsHome() {
  const { companyId, role } = useCompany();
  const data = useQuery(api.applicationForms.overview, { companyId });
  const ensure = useMutation(api.applicationForms.ensureStarter);
  const duplicate = useMutation(api.applicationForms.duplicate);
  const setForm = useMutation(api.hiringNeeds.setForm);
  const setPublic = useMutation(api.hiringNeeds.setPublicApply);
  const { busy, error, run } = useRun();
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const router = useRouter();
  const seeded = useRef(false);
  const owner = role === "owner";

  useEffect(() => {
    if (!data || seeded.current || data.forms.length > 0 || !data.canDraft) return;
    seeded.current = true;
    void ensure({ companyId }).catch(() => undefined);
  }, [data, ensure, companyId]);

  if (!data) {
    return (
      <>
        <PageHeader title="Application forms" lead={LEAD} />
        <Skeleton className="h-96 rounded-2xl" />
      </>
    );
  }
  const openRoles = data.roles.filter((row) => row.status === "open");
  const publishedForms = data.forms.filter((form) => form.publishedVersion !== null);

  return (
    <>
      <PageHeader
        title="Application forms"
        lead={LEAD}
        actions={
          data.canDraft ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setSending(true)} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Envelope aria-hidden /> Send application
              </button>
              <button type="button" onClick={() => setCreating(true)} className={buttonVariants({ variant: "primary", size: "sm" })}>
                <Plus aria-hidden /> New form
              </button>
            </div>
          ) : null
        }
      />
      <FormError message={error} />

      <div className="grid gap-4">
        <div className="grid gap-3 @3xl/main:grid-cols-2 @6xl/main:grid-cols-3" data-testid="forms">
          {data.forms.length === 0 ? <Skeleton className="h-36 rounded-2xl" /> : null}
          {data.forms.map((form) => (
            <article key={form.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`${FORMS_ROOT}/${form.id}`} className="font-heading text-base font-medium tracking-tight text-strong hover:underline">
                    {form.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {form.questions} questions · {form.display === "one_at_a_time" ? "one at a time" : "one page"}
                  </p>
                </div>
                <span aria-hidden className="mt-1 size-3 shrink-0 rounded-full" style={{ background: form.accentColor }} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {form.isDefault ? (
                  <Badge variant="info" size="sm">
                    <Star aria-hidden /> Default
                  </Badge>
                ) : null}
                <Badge variant={form.publishedVersion ? "success" : "outline"} size="sm">
                  {form.publishedVersion ? `Published v${form.publishedVersion}` : "Draft"}
                </Badge>
                {form.publishedVersion && form.draftDiffers ? (
                  <Badge variant="warning" size="sm">
                    Unpublished changes
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">{form.usedBy.length ? `Used by ${form.usedBy.join(", ")}` : "No role uses it yet."}</p>
              <div className="mt-auto flex flex-wrap gap-2">
                <Link href={`${FORMS_ROOT}/${form.id}`} className={buttonVariants({ variant: "outline", size: "xs" })}>
                  {data.canDraft ? "Edit" : "View"}
                </Link>
                {data.canDraft ? (
                  <button type="button" disabled={busy} onClick={() => void run(async () => router.push(`${FORMS_ROOT}/${await duplicate({ companyId, formId: form.id })}`))} className={buttonVariants({ variant: "ghost", size: "xs" })}>
                    <CopyIcon aria-hidden /> Duplicate
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <Panel title="Roles and how applicants reach them">
          <div className="space-y-3 p-4 sm:p-5">
            {data.careersUrl ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-strong">Careers page</span>
                  <span className="block truncate text-muted-foreground">{data.careersUrl}</span>
                </span>
                <CopyButton value={data.careersUrl} label="Copy link" />
              </div>
            ) : (
              <Notice tone="warning" title="No public address yet">
                Set your company&apos;s public address in{" "}
                <Link href="/app/agents/sales/booking-forms?panel=rules" className="font-medium underline">
                  Booking rules
                </Link>{" "}
                to give roles a public application page. Emailed links work without it.
              </Notice>
            )}
            {data.roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No roles yet.{" "}
                <Link href="/app/agents/recruiter/hiring-setup" className="font-medium underline">
                  Open a role in Hiring setup
                </Link>
                .
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 font-medium">Role</th>
                      <th className="py-2 font-medium">Application form</th>
                      <th className="py-2 font-medium">Public page</th>
                      <th className="py-2 font-medium">
                        <span className="sr-only">Link</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.roles.map((row) => (
                      <tr key={row.id} className="border-t border-border align-middle">
                        <td className="py-2.5 pr-3">
                          <span className="font-medium text-strong">{row.title}</span>
                          <span className="block text-xs text-muted-foreground capitalize">{row.status}</span>
                        </td>
                        <td className="py-2.5 pr-3">
                          {owner ? (
                            <Select
                              aria-label={`Form for ${row.title}`}
                              density="compact"
                              value={row.formId ?? ""}
                              emptyLabel={`Default (${data.forms.find((form) => form.isDefault && form.publishedVersion)?.name ?? "Short form"})`}
                              options={publishedForms.map((form) => ({ value: form.id, label: form.name }))}
                              onValueChange={(next) => void run(() => setForm({ companyId, needId: row.id, formId: (next || null) as Id<"applicationForms"> | null }))}
                            />
                          ) : (
                            <span className="text-strong">{row.formName}</span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="flex items-center gap-2">
                            <Switch checked={row.publicApply} disabled={!owner || busy} label={`Public application page for ${row.title}`} onChange={(on) => void run(() => setPublic({ companyId, needId: row.id, publicApply: on }))} />
                            <span className="text-xs text-muted-foreground">{row.publicApply ? (row.status === "open" ? "Anyone can apply" : "When the role opens") : "Emailed link only"}</span>
                          </span>
                        </td>
                        <td className="py-2.5 text-right">{row.publicApply && row.url ? <CopyButton value={row.url} label="Copy link" /> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!owner ? <p className="text-xs text-muted-foreground">The Owner chooses each role&apos;s form and whether it has a public page.</p> : null}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lightning aria-hidden className="mt-0.5 size-3.5 shrink-0" /> Questions marked as ending an application only ever close one when a person agrees, unless you allowed Recruiter to decline on fixed requirements in Agent permissions.
            </p>
          </div>
        </Panel>
      </div>

      <NewFormModal open={creating} onClose={() => setCreating(false)} templates={data.templates} />
      <SendApplicationDialog open={sending} onClose={() => setSending(false)} roles={openRoles.map((row) => ({ id: row.id, title: row.title }))} />
    </>
  );
}

function NewFormModal({ open, onClose, templates }: { open: boolean; onClose: () => void; templates: { key: string; name: string; blurb: string }[] }) {
  const { companyId } = useCompany();
  const create = useMutation(api.applicationForms.create);
  const { busy, error, run } = useRun();
  const router = useRouter();
  return (
    <Modal open={open} onClose={onClose} title="Start a new form" description="Begin from a template. You can change every question, the order, the look and the email.">
      <div className="grid gap-2">
        {templates.map((template) => (
          <button
            key={template.key}
            type="button"
            disabled={busy}
            onClick={() => void run(async () => router.push(`${FORMS_ROOT}/${await create({ companyId, template: template.key as "standard_cleaner" | "quick_apply" | "classic" })}`))}
            className="rounded-xl border border-border px-3.5 py-3 text-left transition-colors hover:border-brand-500/50 hover:bg-brand-500/[0.04]"
          >
            <p className="text-sm font-medium text-strong">{template.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{template.blurb}</p>
          </button>
        ))}
        <FormError message={error} />
      </div>
    </Modal>
  );
}
