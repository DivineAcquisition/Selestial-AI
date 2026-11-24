#!/usr/bin/env node
/**
 * Seeds the local demo backend for a tutorial's starting state. Every record is synthetic.
 *
 *   node tutorials/demo/seed.mjs plan <label>        the label's company gets the Operate plan
 *   node tutorials/demo/seed.mjs company <label>     Juniper Cleaning Co. as tutorial 1 leaves it: plan, setup
 *                                                    basics, ZIP codes and booking hours, workspace opened
 *   node tutorials/demo/seed.mjs service <label>     publishes "Standard home cleaning" through the real screens,
 *                                                    as tutorial 2 does (unrecorded)
 *
 * <label> names a demo owner made by owner.mjs (tutorials/.auth/<label>.person.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BASE, COMPANY, convex, launch, ROOT } from "./lib.mjs";

const [command, label] = process.argv.slice(2);
const person = JSON.parse(readFileSync(join(ROOT, "tutorials/.auth", `${label}.person.json`), "utf8"));
const me = person.identity;
const company = () => {
  const rows = convex("companies:mine", {}, me);
  if (!rows?.length) throw new Error(`${label} has no company yet.`);
  return rows[0].companyId;
};

if (command === "plan") {
  convex("tutorialDemo:setPlan", { companyId: company(), plan: "operate" });
  console.log("plan: operate");
} else if (command === "company") {
  const companyId = convex("companies:create", { name: COMPANY.name, timezone: COMPANY.timezone, acceptTerms: "terms-2026-11-16" }, me);
  convex("tutorialDemo:setPlan", { companyId, plan: "operate" });
  const at = (step, extra = {}) => {
    const state = convex("setup:state", { companyId }, me);
    convex("setup:save", { companyId, expectedRevision: state.setup.revision, step, ...extra }, me);
  };
  at("basics", { methods: ["manual"] });
  at("team", { facts: { "company.location": "Austin, TX", "company.areas": "Austin, Round Rock, Pflugerville", "services.categories": ["residential", "commercial"] } });
  at("priority", { facts: { "workforce.arrangement": ["contractors"], "scale.cleaners": "6-15" } });
  at("priority", { priority: "dispatch" });
  convex("setup:enter", { companyId }, me);
  const business = convex("settings:business", { companyId }, me);
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 480, endMinute: 1020 }));
  convex("settings:saveBusiness", { companyId, expectedRevision: business.revision, name: COMPANY.name, timezone: COMPANY.timezone, serviceAreas: ["78701", "78702", "78704", "78745"], hours: weekdays, services: business.services ?? [] }, me);
  console.log(`company: ${companyId}`);
} else if (command === "service") {
  const browser = await launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: join(ROOT, "tutorials/.auth", `${label}.json`) })).newPage();
  await page.goto(`${BASE}/app/services/new?mode=blank`, { waitUntil: "networkidle" });
  await page.getByLabel("Name customers will see").fill("Standard home cleaning");
  await page.getByText("Residential", { exact: true }).first().click();
  await page.getByRole("button", { name: "Start building" }).click();
  await page.getByText("Step 1 of 6").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Next: Scope" }).click();
  await page.getByRole("button", { name: "Next: Pricing" }).click();
  await page.getByText("Bedrooms and bathrooms", { exact: true }).first().click();
  for (const [field, value] of [["Base price", "120"], ["Each extra bedroom", "20"], ["Each extra bathroom", "15"]]) {
    await page.getByLabel(field).fill(value);
    await page.getByLabel(field).blur();
  }
  for (const next of ["Next: Time & Team", "Next: Extras", "Next: Review"]) await page.getByRole("button", { name: next }).click();
  await page.getByLabel("Why this change").fill("Our standard home clean, priced by bedrooms and bathrooms.");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByText("In review").first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await page.getByText("Published").first().waitFor({ timeout: 30000 });
  await browser.close();
  console.log("service: Standard home cleaning, published");
} else throw new Error(`Unknown command ${command}.`);
