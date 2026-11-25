/**
 * The tutorial demo environment: a LOCAL Convex backend (`npx convex dev` with no account) and the Clerk
 * DEVELOPMENT instance. Nothing here may touch a real deployment, a real inbox or a real phone:
 *   - every Convex call runs without CONVEX_DEPLOY_KEY, so it reaches the local backend named in .env.local;
 *   - the sign-in service is checked to be a development instance before anything is created;
 *   - demo people use "+clerk_test@example.com" addresses, which the sign-in service never emails;
 *   - the backend runs with MESSAGING_PROVIDER=mock and EMAIL_PROVIDER=mock.
 * See tutorials/SETUP-SERIES.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const BASE = process.env.TUTORIAL_BASE ?? "http://localhost:3100";
const CLERK = "https://api.clerk.com/v1";

/** The fictional company every setup tutorial shows. Synthetic: example.com addresses and 555-01xx numbers only. */
export const COMPANY = {
  name: "Juniper Cleaning Co.",
  owner: "Jordan Reyes",
  city: "Austin",
  region: "TX",
  timezone: "America/Chicago",
};

function localEnv() {
  const env = { ...process.env };
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_PROD_DEPLOY_KEY;
  const file = readFileSync(join(ROOT, ".env.local"), "utf8");
  const url = /NEXT_PUBLIC_CONVEX_URL=(\S+)/.exec(file)?.[1] ?? "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error(`Refusing: .env.local points at ${url || "nothing"}, not a local backend.`);
  return env;
}

/** Runs a Convex function on the local backend as the given demo person. */
export function convex(fn, args = {}, identity) {
  const flags = identity ? ["--identity", JSON.stringify(identity)] : [];
  const out = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args), ...flags], { cwd: ROOT, env: localEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const text = out.trim();
  return text ? JSON.parse(text) : null;
}

async function clerk(method, path, body) {
  // The network proxy supplies the development key; a placeholder is sent and replaced.
  const response = await fetch(`${CLERK}${path}`, { method, headers: { authorization: `Bearer ${process.env.CLERK_SECRET_KEY || "sk_test_proxy"}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json?.errors?.map((e) => e.code) ?? json)}`);
  return json;
}

export async function assertDevelopment() {
  const instance = await clerk("GET", "/instance");
  if (instance.environment_type !== "development") throw new Error("Refusing: the sign-in instance is not a development instance.");
  const domains = await clerk("GET", "/domains");
  return { issuer: domains.data[0].frontend_api_url.replace(/\/$/, ""), fapiHost: new URL(domains.data[0].frontend_api_url).host };
}

/** A new demo owner. A fresh person per run keeps each tutorial's starting state exact. */
export async function makeOwner(label) {
  const { issuer } = await assertDevelopment();
  const run = `${label}-${Date.now().toString(36)}`;
  const email = `demo-${run}+clerk_test@example.com`;
  const password = `Demo-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const [first_name, last_name] = COMPANY.owner.split(" ");
  const user = await clerk("POST", "/users", { email_address: [email], password, first_name, last_name, legal_accepted_at: new Date().toISOString() });
  const identity = { subject: user.id, issuer, tokenIdentifier: `${issuer}|${user.id}`, email, emailVerified: true, name: COMPANY.owner };
  return { id: user.id, email, password, identity };
}

export function chromium() {
  return createRequire(import.meta.url)("playwright").chromium;
}

export async function launch() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium().launch({ proxy: proxy ? { server: proxy, bypass: "localhost,127.0.0.1" } : undefined });
}

/** Lets the scripted browser past the sign-in service's bot check, its supported way for development instances. */
export async function passBotCheck(context) {
  const { fapiHost } = await assertDevelopment();
  const { token } = await clerk("POST", "/testing_tokens");
  await context.route(`https://${fapiHost}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("__clerk_testing_token", token);
    await route.continue({ url: url.toString() });
  });
}

/** Signs the person in through Selestial's own sign-in page and saves the browser session. */
export async function signIn(person, storagePath) {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  await passBotCheck(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const code = page.getByLabel("Code");
  await Promise.race([code.waitFor({ timeout: 20000 }).then(async () => {
    await code.fill("424242");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }), page.waitForURL(/\/app/, { timeout: 20000 })]).catch(() => undefined);
  await page.waitForURL(/\/app/, { timeout: 30000 });
  await context.storageState({ path: storagePath });
  await browser.close();
}
