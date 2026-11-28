import { AgentMark } from "@/components/marketing/agent-mark";

/**
 * The hero's illustrative Recruiter workspace: what got done, one applicant with evidence from their
 * answers, a prepared next action and what waits for the owner. Sample data, labelled as such.
 */
export function HeroWorkspace() {
  return (
    <figure className="relative">
      <div aria-hidden className="absolute inset-x-0 -inset-y-6 -z-10 rounded-[2.5rem] sm:-inset-6 bg-[radial-gradient(60%_60%_at_70%_20%,rgba(104,56,239,0.14),transparent_70%)]" />
      <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-[0_40px_90px_-55px_rgba(33,26,53,0.6)]">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-[#f8f9fc] px-5 py-3.5">
          <div className="flex items-center gap-3">
            <AgentMark id="recruiter" size="md" />
            <div>
              <p className="text-sm font-semibold text-strong">Recruiter</p>
              <p className="text-xs text-muted-foreground">Residential Cleaner · Weekday team</p>
            </div>
          </div>
          <span className="rounded-full border border-[#e2d9ff] bg-[#eee8ff] px-2.5 py-1 text-[11px] font-semibold text-[#5126c7]">Illustrative</span>
        </div>

        <div className="space-y-4 p-5">
          <section aria-label="Since you last checked" className="rounded-2xl border border-border p-4">
            <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Since you last checked</p>
            <ul className="mt-2.5 space-y-1.5 text-[14px] text-strong">
              <li className="flex gap-2"><Tick /> 3 applications organized from your hiring inbox</li>
              <li className="flex gap-2"><Tick /> 2 applicants reminded to finish their form</li>
              <li className="flex gap-2"><Tick /> Jordan completed their application</li>
            </ul>
          </section>

          <section aria-label="Applicant" className="rounded-2xl border border-[#e2d9ff] bg-[#fbfaff] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span aria-hidden className="grid size-9 place-items-center rounded-full bg-[#eee8ff] text-sm font-semibold text-[#5126c7]">JR</span>
                <div>
                  <p className="text-[15px] font-semibold text-strong">Jordan Reyes</p>
                  <p className="text-xs text-muted-foreground">2 years residential cleaning · Applied via your link</p>
                </div>
              </div>
            </div>
            <dl className="mt-3 grid gap-2 text-[13.5px]">
              <Evidence label="Weekday availability" outcome="Matches your role" quote="“Mon–Fri, 8am to 3pm”" tone="ok" />
              <Evidence label="Service area" outcome="Matches" quote="“I live in Silver Spring, have a car”" tone="ok" />
              <Evidence label="Pet-friendly homes" outcome="Unclear" quote="Not answered — flagged for you" tone="unclear" />
            </dl>
          </section>

          <section aria-label="Needs your review" className="flex flex-col gap-3 rounded-2xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold tracking-[0.12em] text-[#5126c7] uppercase">Needs your review</p>
              <p className="mt-1 text-[15px] font-medium text-strong">Interview invitation ready to review</p>
              <p className="text-xs text-muted-foreground">Offers Thursday or Friday morning. Sends only after you approve.</p>
            </div>
            <span aria-hidden className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-[#6838ef] px-3.5 text-sm font-semibold text-white">Review</span>
          </section>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground">Illustration with sample data — not a real applicant.</figcaption>
    </figure>
  );
}

function Tick() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-[#6838ef]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Evidence({ label, outcome, quote, tone }: { label: string; outcome: string; quote: string; tone: "ok" | "unclear" }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-x-2.5 rounded-xl bg-white px-3 py-2 ring-1 ring-border">
      <span aria-hidden className={tone === "ok" ? "mt-1.5 size-2 rounded-full bg-emerald-500" : "mt-1.5 size-2 rounded-full bg-amber-500"} />
      <div className="min-w-0">
        <dt className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-medium text-strong">{label}</span>
          <span className={tone === "ok" ? "text-xs font-semibold text-emerald-700" : "text-xs font-semibold text-amber-700"}>{outcome}</span>
        </dt>
        <dd className="text-xs text-muted-foreground">{quote}</dd>
      </div>
    </div>
  );
}
