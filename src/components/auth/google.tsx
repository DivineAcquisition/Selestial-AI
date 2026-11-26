"use client";

/**
 * Signing in and creating an account with Google. The sign-in service does the Google part; every screen
 * is still Selestial's. Google sends the person back to `/auth/sso-callback`, which finishes the sign-in
 * or sign-up and goes on to `/auth/callback`, the same place every sign-in ends.
 *
 * Creating an account with Google sends the agreement to the Terms and Privacy Policy that the person
 * ticked on the form. Someone who chose Google on the sign-in page and has no account yet is asked to
 * agree on `/auth/continue` before the account is made.
 */
import { HandleSSOCallback, useAuth, useSignIn, useSignUp } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConsentField, Notice, QuietButton, SubmitButton, TextField } from "@/components/auth/fields";
import { enter, goOn, useNext } from "@/components/auth/flow";
import { AuthLink, AuthShell, useEvents, type TraceStep } from "@/components/auth/shell";
import { problemOf, type AuthProblem } from "@/lib/auth/errors";
import { splitName } from "@/lib/auth/password";
import { AUTH, inviteTokenIn, withNext, withParam } from "@/lib/auth/routes";

const STRATEGY = "oauth_google";

/** What `/auth/continue` can ask for. Anything else the service wants means setup is unfinished. */
const ASKABLE = new Set(["legal_accepted", "first_name", "last_name"]);

/**
 * What is sent to start Google. Both addresses keep the checked destination; creating an account sends
 * the agreement the person ticked on the form.
 */
export function googleRequest(mode: "signin" | "signup", next: string | null) {
  const base = { strategy: STRATEGY, redirectUrl: withNext(AUTH.callback, next), redirectCallbackUrl: withNext(AUTH.sso, next) } as const;
  return mode === "signup" ? { ...base, legalAccepted: true as const } : base;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px] shrink-0" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A8.64 8.64 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

/** "or", between the email form and the Google button. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-[#98a2b3]" role="separator" aria-label="or">
      <span className="h-px flex-1 bg-[#e4e7ef]" aria-hidden />
      or
      <span className="h-px flex-1 bg-[#e4e7ef]" aria-hidden />
    </div>
  );
}

/**
 * Sends the person to Google. On the sign-up page it is held until the agreement is ticked, and the
 * agreement goes with the request. Either way, a Google account that already has a Selestial account
 * signs in, and one that has none creates it.
 */
export function GoogleButton({ mode, next, disabled, onProblem, onStart }: { mode: "signin" | "signup"; next: string | null; disabled?: boolean; onProblem: (problem: AuthProblem) => void; onStart?: () => void }) {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const [busy, setBusy] = useState(false);

  async function start() {
    if (busy || disabled) return;
    setBusy(true);
    onStart?.();
    try {
      const { error } = mode === "signup" ? await signUp.sso(googleRequest("signup", next)) : await signIn.sso(googleRequest("signin", next));
      if (error) {
        onProblem(problemOf(error));
        setBusy(false);
      }
      // Otherwise the browser is already on its way to Google.
    } catch (error) {
      onProblem(problemOf(error));
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy || disabled || !(mode === "signup" ? signUp : signIn)}
      aria-busy={busy}
      data-testid="google"
      className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-[#d5dae5] bg-white px-4 text-[15px] font-medium text-[#211a35] transition-colors hover:border-[#b9c0cf] hover:bg-[#f8f9fc] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6838ef] disabled:cursor-not-allowed disabled:text-[#98a2b3]"
    >
      <GoogleMark />
      {busy ? "Opening Google" : "Continue with Google"}
    </button>
  );
}

/** Google's return. The service finishes what it can; this page only decides where the person goes next. */
export function SsoCallbackScreen() {
  const router = useRouter();
  const next = useNext();
  const { events } = useEvents();
  const steps: TraceStep[] = [
    { key: "google", label: "Confirm who you are with Google", detail: "Google tells the sign-in service which account you chose. Selestial never sees your Google password.", state: "done" },
    { key: "session", label: "Confirm your session", detail: "Nothing opens until the session is confirmed as yours.", state: "active" },
    { key: "workspace", label: inviteTokenIn(next) ? "Return to your invitation" : "Open your workspace", detail: "You land in your company, or in setup if you do not have one yet.", state: "todo" },
  ];
  return (
    <AuthShell eyebrow="Signing in" title="Finishing with Google" lead="This takes a moment." steps={steps} events={events}>
      <div className="flex items-center gap-3 rounded-xl border border-[#e4e7ef] bg-[#f8f9fc] px-3.5 py-3 text-sm text-[#667085]" role="status" aria-live="polite">
        <span className="auth-dot relative size-2 shrink-0 rounded-full bg-[#6838ef] text-[#6838ef]" aria-hidden />
        Confirming your Google sign-in.
      </div>
      <HandleSSOCallback
        navigateToApp={goOn(router, withNext(AUTH.callback, next))}
        // A second step (a code on a new device), or a security check that did not pass: the sign-in page takes it from here.
        navigateToSignIn={() => router.replace(withParam(withNext(AUTH.login, next), "reason", "google"))}
        // A first sign-in with Google that still needs an agreement or a name.
        navigateToSignUp={() => router.replace(withNext(AUTH.continue, next))}
      />
    </AuthShell>
  );
}

/**
 * The last step of a first sign-in with Google: agree to the Terms and Privacy Policy (and give a name,
 * if Google did not share one). Nothing is created until the person chooses to.
 */
export function ContinueScreen() {
  const router = useRouter();
  const next = useNext();
  const { signUp } = useSignUp();
  const { isLoaded, isSignedIn } = useAuth();
  const { events, note } = useEvents();
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState(false);
  const [problem, setProblem] = useState<AuthProblem | null>(null);
  const invited = inviteTokenIn(next) !== null;
  const missing = signUp?.missingFields ?? [];
  const pending = Boolean(signUp?.id) && signUp?.status === "missing_requirements";
  const unaskable = missing.filter((field) => !ASKABLE.has(field) && field !== "protect_check");
  const needsName = missing.includes("first_name") || missing.includes("last_name");
  const shownName = name ?? [signUp?.firstName, signUp?.lastName].filter(Boolean).join(" ");

  const steps: TraceStep[] = [
    { key: "google", label: "Confirm who you are with Google", detail: "Done.", state: "done" },
    { key: "account", label: "Create your account", detail: "Agree to the Terms and Privacy Policy. Business details come later, in workspace setup.", state: entering ? "done" : busy ? "active" : problem ? "failed" : "needs_you" },
    { key: "session", label: "Confirm your session", detail: "You are signed in only after the account is made.", state: entering ? "active" : "todo" },
    { key: "workspace", label: invited ? "Return to your invitation" : "Set up your workspace", detail: invited ? "You go back to the invitation and join that company." : "Name your company. You become its Owner.", state: "todo" },
  ];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !signUp || !agreed) return;
    setBusy(true);
    setProblem(null);
    note("Creating your account");
    const { firstName, lastName } = splitName(shownName);
    // The agreement is sent with the account, so the sign-in service records when it was given.
    const { error } = await signUp.update({ legalAccepted: true, ...(needsName ? { firstName, lastName } : {}) });
    if (error) {
      setProblem(problemOf(error));
      note("Account not created");
      setBusy(false);
      return;
    }
    if (signUp.status !== "complete") {
      setProblem({ message: "We couldn’t create your account just now. Nothing was created. Please try again later.", kind: "setup" });
      note("Sign-up settings need changing");
      setBusy(false);
      return;
    }
    note("Account created");
    setEntering(true);
    const failure = await enter(signUp, router, next);
    if (failure) {
      setEntering(false);
      setProblem(problemOf(failure));
    }
    setBusy(false);
  }

  const fail = (error: unknown) => {
    setProblem(problemOf(error));
    setBusy(false);
    setEntering(false);
    note("Stopped by an unexpected problem");
  };

  if (isLoaded && isSignedIn && !entering) {
    return (
      <AuthShell eyebrow="Create account" title="You are already signed in" steps={steps} events={events}>
        <QuietButton onClick={() => router.replace(withNext(AUTH.callback, next))}>Continue</QuietButton>
      </AuthShell>
    );
  }
  if (signUp && (!pending || unaskable.length > 0) && !entering) {
    return (
      <AuthShell
        eyebrow="Create account"
        title={unaskable.length > 0 ? "Sign-up isn’t available right now" : "There is nothing to finish here"}
        lead={unaskable.length > 0 ? "Nothing was created. Please try again later, or create your account with your email address." : "This page finishes a sign-up started with Google in this browser. Start again from the sign-up page, or sign in."}
        steps={steps}
        events={events}
      >
        <div className="grid gap-3">
          <QuietButton onClick={() => router.push(withNext(AUTH.signup, next))}>Create an account</QuietButton>
          <QuietButton onClick={() => router.push(withNext(AUTH.login, next))}>Sign in</QuietButton>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Create account"
      title="One last step"
      lead={
        signUp?.emailAddress ? (
          <>
            You are creating a Selestial account for <span className="font-semibold text-[#211a35]">{signUp.emailAddress}</span> with Google.
          </>
        ) : (
          "Loading your sign-up."
        )
      }
      steps={steps}
      events={events}
      below={
        <>
          Not you? <AuthLink href={withNext(AUTH.signup, next)}>Use a different account</AuthLink>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event).catch(fail)} className="grid gap-4" noValidate>
        {needsName ? <TextField label="Full name" name="name" value={shownName} onChange={(event) => setName(event.target.value)} autoComplete="name" required maxLength={120} /> : null}
        <ConsentField checked={agreed} onChange={setAgreed} disabled={busy || entering} />
        {problem ? <Notice tone="error">{problem.message}</Notice> : null}
        <div id="clerk-captcha" data-cl-theme="light" data-cl-size="flexible" />
        <SubmitButton busy={busy || entering} busyLabel={entering ? "Opening your workspace" : "Creating your account"} disabled={!pending || !agreed || (needsName && shownName.trim() === "")}>
          Create account
        </SubmitButton>
      </form>
    </AuthShell>
  );
}
