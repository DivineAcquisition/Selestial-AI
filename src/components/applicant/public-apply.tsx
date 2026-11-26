"use client";

/**
 * The company's public application pages. Anyone can open them; nothing here is private. Starting asks
 * only for a name and an email, then hands the applicant to their own private link, where the rest of
 * the form saves as they go, exactly as an emailed invitation would.
 */
import { useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";

import { Action, Card, Notice, Problem } from "@/components/cleaner/shell";

import { api } from "../../../convex/_generated/api";
import { startApplication } from "../../app/apply/actions";
import { ApplyFrame } from "./form/application-form";
import { inputClass } from "./form/fields";

const ENGAGEMENT = { contractor: "Independent contractor", employee: "Employee" } as const;

function Gone({ title, body }: { title: string; body: string }) {
  return (
    <ApplyFrame look={{ accentColor: "#6838ef", logoUrl: null, companyName: "Selestial", title }}>
      <Notice tone="neutral" title={title} testId="state-unavailable">
        {body}
      </Notice>
    </ApplyFrame>
  );
}

function Skeleton() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-3 px-4 pt-5" aria-busy="true">
      <div className="h-10 animate-pulse rounded-xl bg-muted" />
      <div className="h-40 animate-pulse rounded-2xl bg-muted" />
    </main>
  );
}

/** /apply/<handle>: every role the company opened to the public. */
export function CareersPage({ handle }: { handle: string }) {
  const data = useQuery(api.applyPublic.careers, { handle });
  if (data === undefined) return <Skeleton />;
  if (data === null) return <Gone title="This page isn't available" body="Check the address, or contact the company directly." />;
  return (
    <ApplyFrame look={{ accentColor: data.company.brandColor, logoUrl: data.company.logoUrl, companyName: data.company.name, title: `Work with ${data.company.name}` }} wide>
      {data.roles.length === 0 ? (
        <Notice tone="neutral" title="No open roles right now" testId="no-roles">
          Please check back later.
        </Notice>
      ) : (
        <ul className="grid gap-3" data-testid="roles">
          {data.roles.map((role) => (
            <li key={role.slug}>
              <Link href={`/apply/${handle}/${role.slug}`} className="block rounded-2xl border border-border bg-card p-4 transition-colors hover:border-[var(--apply-accent)]">
                <p className="text-base font-semibold text-foreground">{role.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {role.location} · {ENGAGEMENT[role.engagement]}
                </p>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{role.summary}</p>
                <span className="mt-3 inline-block text-sm font-semibold text-[var(--apply-accent)]">Apply →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ApplyFrame>
  );
}

/** /apply/<handle>/<role>: the role, then a name and an email to start. */
export function RoleApplyPage({ handle, slug }: { handle: string; slug: string }) {
  const data = useQuery(api.applyPublic.role, { handle, slug });
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);

  if (data === undefined) return <Skeleton />;
  if (data === null) return <Gone title="This page isn't available" body="Check the address, or contact the company directly." />;
  if (!data.role || !data.look) {
    return (
      <ApplyFrame look={{ accentColor: data.company.brandColor, logoUrl: data.company.logoUrl, companyName: data.company.name, title: "This role isn't taking applications" }}>
        <Notice tone="neutral" title="Applications for this role are closed" testId="state-closed">
          <Link href={`/apply/${handle}`} className="font-medium underline">
            See the roles {data.company.name} is hiring for
          </Link>
          .
        </Notice>
      </ApplyFrame>
    );
  }
  const { role, look } = data;
  const start = async () => {
    setBusy(true);
    setProblem(null);
    const result = await startApplication({ handle, slug, name, email, website });
    setBusy(false);
    if (!result.ok) return setProblem(result.why);
    if ("checkEmail" in result) return setCheckEmail(result.checkEmail);
    router.push(`/c/apply/${result.token}`);
  };
  const ready = name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email.trim());

  return (
    <ApplyFrame look={{ accentColor: look.accentColor, logoUrl: look.logoUrl, companyName: look.companyName, title: look.copy.title }}>
      <Card>
        <p className="text-base font-semibold">{role.title}</p>
        <p className="text-xs text-muted-foreground">
          {role.location} · {ENGAGEMENT[role.engagement]}
        </p>
        <p className="text-sm whitespace-pre-line">{role.responsibilities}</p>
        {role.availability ? <p className="text-sm text-muted-foreground">Availability: {role.availability}</p> : null}
      </Card>
      {checkEmail ? (
        <Notice tone="good" title="Check your email" testId="check-email">
          {checkEmail}
        </Notice>
      ) : (
        <form
          className="flex flex-col gap-3"
          style={{ "--apply-accent": look.accentColor } as CSSProperties}
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) void start();
          }}
        >
          {look.copy.intro ? <p className="text-sm">{look.copy.intro}</p> : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Full name *</span>
            <input data-testid="start-name" autoComplete="name" maxLength={80} className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Email address *</span>
            <input data-testid="start-email" type="email" autoComplete="email" maxLength={160} className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} />
            <span className="text-xs text-muted-foreground">We send updates about your application here, and a link to come back and finish.</span>
          </label>
          {/* People never see this field. A script that fills in every field fills this one too. */}
          <label aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
            Website
            <input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
          </label>
          <Problem message={problem} />
          <Action busy={busy} disabled={!ready} onPress={() => void start()} testId="start">
            Start my application
          </Action>
          <p className="text-xs text-muted-foreground">By starting, you agree that {look.companyName} may email you about this application. You can ask them to stop at any time.</p>
        </form>
      )}
    </ApplyFrame>
  );
}

/** /apply/<handle>/<role>/embed: a small card for the company's own website. It opens the full page in a new tab. */
export function RoleEmbed({ handle, slug }: { handle: string; slug: string }) {
  const data = useQuery(api.applyPublic.role, { handle, slug });
  if (data === undefined) return <div className="h-40 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none" aria-busy="true" />;
  if (!data || !data.role || !data.look) return <p className="p-4 text-sm text-muted-foreground">This role isn&apos;t taking applications right now.</p>;
  const target = `/apply/${handle}/${slug}`;
  return (
    <div className="p-2" style={{ "--apply-accent": data.look.accentColor } as CSSProperties}>
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{data.company.name} is hiring</p>
        <p className="text-lg font-semibold tracking-tight">{data.role.title}</p>
        <p className="text-sm text-muted-foreground">
          {data.role.location} · {ENGAGEMENT[data.role.engagement]}
        </p>
        <button type="button" onClick={() => window.open(target, "_blank", "noopener")} className="mt-1 min-h-11 rounded-xl bg-[var(--apply-accent)] px-4 text-base font-semibold text-white">
          Apply now
        </button>
      </div>
    </div>
  );
}
