"use client";

/**
 * Applicants as a board: one column per part of the hiring pipeline, from the application's own stage.
 * Dragging a card (or choosing "Move to" on it) does what the matching button does, after the person
 * confirms what will happen. Columns the system moves people into take no drops.
 */
import { useMutation } from "convex/react";
import { useState } from "react";

import { useCompany } from "@/components/app/company";
import { Field, FormError, TextArea, useRun } from "@/components/app/form";
import { Modal } from "@/components/app/modal";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/selection";
import { cn } from "@/lib/utils";

import { api } from "../../../../../convex/_generated/api";
import { COLUMNS, columnOf, moveFor, type ColumnId } from "../../../../../convex/lib/recruiter/board";
import { CLOSURE_REASONS } from "../../../../../convex/lib/recruiter/schema";
import { CLOSURE_WORDS, SOURCE_WORDS, STAGE_WORDS, WhoActs, type ApplicationRow } from "./shared";

type Pending = { row: ApplicationRow; to: ColumnId };

export function PipelineBoard({ rows, openId, onOpen, canMove }: { rows: ApplicationRow[]; openId: string | null; onOpen: (id: ApplicationRow["applicationId"]) => void; canMove: boolean }) {
  const [dragging, setDragging] = useState<ApplicationRow | null>(null);
  const [over, setOver] = useState<ColumnId | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const columns = COLUMNS.filter((column) => column.id !== "closed");

  const drop = (to: ColumnId) => {
    const row = dragging;
    setDragging(null);
    setOver(null);
    if (row && moveFor(row.stage, to)) setPending({ row, to });
  };

  return (
    <>
      {notice ? (
        <p role="status" className="mb-3 rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-strong" data-testid="board-notice">
          {notice}
        </p>
      ) : null}
      <div className="flex gap-3 overflow-x-auto pb-3" data-testid="board">
        {columns.map((column) => {
          const cards = rows.filter((row) => columnOf(row.stage) === column.id).sort((a, b) => b.appliedAt - a.appliedAt);
          const allowed = dragging ? moveFor(dragging.stage, column.id) !== null : false;
          return (
            <section
              key={column.id}
              aria-labelledby={`column-${column.id}`}
              data-testid={`column-${column.id}`}
              onDragOver={(event) => {
                if (!dragging || !allowed) return;
                event.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver((current) => (current === column.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                drop(column.id);
              }}
              className={cn("flex w-64 shrink-0 flex-col gap-2 rounded-2xl border p-2.5 transition-colors", over === column.id ? "border-brand-500 bg-brand-500/5" : dragging && allowed ? "border-dashed border-brand-500/50 bg-muted/30" : dragging ? "border-border bg-muted/10 opacity-60" : "border-border bg-muted/30")}
            >
              <h2 id={`column-${column.id}`} className="flex items-center justify-between px-1 text-sm font-semibold text-strong">
                {column.label} <span className="text-xs font-normal tabular-nums text-muted-foreground">{cards.length}</span>
              </h2>
              {cards.length === 0 ? <p className="px-1 py-4 text-center text-xs text-muted-foreground">{dragging && allowed ? "Drop here" : "Nobody here"}</p> : null}
              {cards.map((row) => (
                <Card key={row.applicationId} row={row} active={openId === row.applicationId} canMove={canMove} dragging={dragging?.applicationId === row.applicationId} onOpen={() => onOpen(row.applicationId)} onDragStart={() => setDragging(row)} onDragEnd={() => { setDragging(null); setOver(null); }} onMove={(to) => setPending({ row, to })} />
              ))}
            </section>
          );
        })}
        <section
          aria-labelledby="column-closed"
          data-testid="column-closed"
          onDragOver={(event) => {
            if (!dragging || !moveFor(dragging.stage, "closed")) return;
            event.preventDefault();
            setOver("closed");
          }}
          onDragLeave={() => setOver((current) => (current === "closed" ? null : current))}
          onDrop={(event) => {
            event.preventDefault();
            drop("closed");
          }}
          className={cn("flex w-44 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl border border-dashed p-3 text-center transition-colors", over === "closed" ? "border-destructive bg-destructive/5" : "border-border")}
        >
          <h2 id="column-closed" className="text-sm font-semibold text-strong">
            Close
          </h2>
          <p className="text-xs text-muted-foreground">Drop a card here to close the application.</p>
        </section>
      </div>
      <MoveDialog pending={pending} onClose={() => setPending(null)} onDone={(detail) => { setPending(null); setNotice(detail); }} />
    </>
  );
}

function Card({ row, active, canMove, dragging, onOpen, onDragStart, onDragEnd, onMove }: { row: ApplicationRow; active: boolean; canMove: boolean; dragging: boolean; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void; onMove: (to: ColumnId) => void }) {
  const targets = COLUMNS.filter((column) => moveFor(row.stage, column.id) !== null);
  const movable = canMove && targets.length > 0 && !row.detailsRemoved;
  return (
    <article
      draggable={movable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.applicationId);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      data-testid={`card-${row.applicationId}`}
      className={cn("grid gap-1.5 rounded-xl border bg-card p-3 text-sm shadow-xs", active ? "border-brand-500" : "border-border", dragging ? "opacity-50" : "", movable ? "cursor-grab active:cursor-grabbing" : "")}
    >
      <button type="button" onClick={onOpen} className="grid gap-0.5 text-left focus-visible:outline-2 focus-visible:outline-brand-500">
        <span className="flex items-start justify-between gap-2">
          <span className="font-medium text-strong">{row.detailsRemoved ? "Details removed" : (row.name ?? "Name not known")}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {row.role ?? row.roleSeen ?? "No role yet"} · {SOURCE_WORDS[row.source]}
        </span>
        <span className="text-xs text-muted-foreground">{STAGE_WORDS[row.stage]}</span>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WhoActs row={row} />
        {movable ? <Select aria-label={`Move ${row.name ?? "applicant"} to`} density="compact" value="" placeholder="Move to…" options={targets.map((column) => ({ value: column.id, label: column.id === "closed" ? "Close" : column.label }))} onValueChange={(next) => next && onMove(next as ColumnId)} /> : null}
      </div>
    </article>
  );
}

function MoveDialog({ pending, onClose, onDone }: { pending: Pending | null; onClose: () => void; onDone: (detail: string) => void }) {
  const { companyId } = useCompany();
  const move = useMutation(api.applications.move);
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  const [closure, setClosure] = useState<string>("not_selected");
  const [note, setNote] = useState("");
  const [tell, setTell] = useState(false);
  const plan = pending ? moveFor(pending.row.stage, pending.to) : null;
  const target = pending ? COLUMNS.find((column) => column.id === pending.to) : null;
  const name = pending?.row.name ?? "this applicant";
  const reset = () => {
    setReason("");
    setNote("");
    setTell(false);
    setClosure("not_selected");
  };
  return (
    <Modal open={Boolean(pending && plan)} onClose={() => { reset(); onClose(); }} title={pending?.to === "closed" ? `Close ${name}'s application?` : `Move ${name} to ${target?.label ?? ""}?`} description={plan?.words}>
      {pending && plan ? (
        <div className="space-y-4">
          {plan.needs === "reason" ? (
            <Field label="Why you're holding them" hint="Kept on the record so the team knows what's being decided.">
              <TextArea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} data-testid="move-reason" />
            </Field>
          ) : null}
          {plan.needs === "closure" ? (
            <>
              <Field label="Why it's closing">
                <Select value={closure} onValueChange={(next) => setClosure(next ?? "not_selected")} options={CLOSURE_REASONS.filter((value) => value !== "hired").map((value) => ({ value, label: CLOSURE_WORDS[value] }))} />
              </Field>
              <Field label="Note (optional)">
                <TextArea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={tell} onCheckedChange={(checked) => setTell(checked)} className="mt-0.5" />
                <span>Email the applicant that their application won&apos;t move forward. No reason is given in the email.</span>
              </label>
            </>
          ) : null}
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>
              Cancel
            </Button>
            <Button
              variant={pending.to === "closed" ? "destructive" : "primary"}
              size="sm"
              loading={busy}
              disabled={plan.needs === "reason" && !reason.trim()}
              data-testid="move-confirm"
              onClick={() =>
                void run(async () => {
                  const result = await move({ companyId, applicationId: pending.row.applicationId, to: pending.to, ...(plan.needs === "reason" ? { reason } : {}), ...(plan.needs === "closure" ? { closure: closure as (typeof CLOSURE_REASONS)[number], note: note || undefined, tellApplicant: tell } : {}) });
                  reset();
                  onDone(`${name}: ${result?.detail ?? "Done."}`);
                })
              }
            >
              {pending.to === "closed" ? "Close application" : "Move"}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
