/**
 * The isolated smoke run: the built site, started with NO backend and NO sign-in keys, answering real
 * requests. It proves the build serves its public pages, says the true offer, and fails closed where a
 * backend or sign-in is needed. It can reach no company's records, so it is safe on every pull request.
 *
 *   npm run build && npx next start -p 3210 &
 *   SMOKE_BASE=http://localhost:3210 node tests/e2e/smoke.mjs
 *
 * What it does NOT prove: anything that needs sign-in, a backend or a provider. Those are the browser runs
 * beside this file (auth.mjs, cleaner-pages.mjs, applicant-pages.mjs, trust.mjs), which need a development
 * sign-in instance and the test backend (docs/launch/release-checks.md).
 */
const BASE = (process.env.SMOKE_BASE ?? "http://localhost:3210").replace(/\/+$/, "");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
};

async function get(path) {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "", body: response.status < 300 ? await response.text() : "" };
}

/** Text as a visitor reads it: tags and the framework's embedded data removed. */
const visible = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// Public pages answer.
for (const path of ["/", "/agents", "/agents/sales", "/agents/dispatch", "/agents/recruiter", "/agents/retention", "/integrations", "/messaging", "/privacy", "/terms", "/eula", "/security", "/security/subprocessors", "/cookies", "/book-a-call"]) {
  const page = await get(path);
  check(`GET ${path} answers`, page.status === 200, `status ${page.status}`);
}

// The offer on the public site is the one on sale: one plan, $299, and no plan that cannot be bought.
const home = visible((await get("/")).body);
check("pricing shows $299", home.includes("$299"));
check("pricing does not sell a $499 plan", !home.includes("$499"));
check("pricing does not sell Expand", !/\bExpand\b/.test(home.replace(/\bExpand (into|your|the)\b/gi, "")));
check("no trial is promised", !/free trial|7-day trial|seven-day trial|14-day trial/i.test(home));
// The early-user offer, if shown, is stated in full: who, how much, for how long, and the price after.
check("the early-user offer is stated in full", !home.includes("$199") || (/\$199\s*\/month for your first 12 months, then \$299/.test(home) && /first 25 companies/.test(home)));
check("the four working agents are named", ["Sales", "Recruiter", "Dispatch", "Retention"].every((name) => home.includes(name)));
check("Team Coordinator is not sold", !/Team Coordinator/.test(home));

// The operations assessment became Book a call: old links and ads land there, campaign tags intact.
const assessment = await get("/assessment?utm_source=ad");
check("the old assessment address leads to Book a call", assessment.status === 308 && /\/book-a-call\?utm_source=ad$/.test(assessment.location), `status ${assessment.status} to ${assessment.location}`);

// A retired route still answers (older links keep working).
const retired = await get("/agents/team-coordinator");
check("the retired Team Coordinator page still answers", retired.status === 200 || (retired.status >= 300 && retired.status < 400), `status ${retired.status}`);

// Without sign-in keys, the workspace and staff console never render: they say so or send the visitor away.
for (const path of ["/app", "/app/settings/billing", "/staff", "/staff/operations"]) {
  const page = await get(path);
  const text = visible(page.body);
  const closed = page.status === 404 || (page.status >= 300 && page.status < 400) || /sign-in is not set up|isn.t available|not available|Not found|be right back|Sign in|Log in/i.test(text);
  check(`GET ${path} fails closed without sign-in`, closed, `status ${page.status}`);
  check(`GET ${path} shows no workspace data`, !/Credits this cycle|Renews |Your plan|Open incidents|Support session/.test(text));
}

// Link pages with a made-up token show nothing about any job, customer or applicant.
for (const path of ["/c/offer/not-a-real-token", "/c/job/not-a-real-token", "/b/resume?token=not-a-real-token", "/n/unsubscribe?token=not-a-real-token"]) {
  const page = await get(path);
  const text = visible(page.body);
  check(`GET ${path} leaks nothing`, page.status !== 500 && !/\b\d{1,5} [A-Z][a-z]+ (St|Ave|Rd|Blvd|Dr)\b/.test(text), `status ${page.status}`);
}

// No provider secret is in anything the browser is sent.
const scripts = [...(await get("/")).body.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((match) => match[0]);
let leaked = "";
for (const src of [...new Set(scripts)].slice(0, 80)) {
  const body = await (await fetch(`${BASE}${src}`)).text();
  const hit = /sk_(live|test)_[A-Za-z0-9]{10,}|rk_(live|test)_[A-Za-z0-9]{10,}|am_sk_[A-Za-z0-9_]{10,}|re_[A-Za-z0-9]{20,}|KEY[0-9A-F]{20,}_|whsec_[A-Za-z0-9]{10,}|-----BEGIN (RSA )?PRIVATE KEY-----/.exec(body);
  if (hit) leaked = `${src}: ${hit[0].slice(0, 8)}…`;
}
check("no provider secret in the browser bundle", !leaked, leaked);

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll smoke checks passed.");
process.exit(failed ? 1 : 0);
