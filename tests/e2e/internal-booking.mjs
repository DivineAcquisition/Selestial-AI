/**
 * The Internal Booking browser run: real pages, a real browser, the real sign-in service and the test record.
 *
 *   NODE_USE_ENV_PROXY=1 CLERK_SECRET_KEY=... node tests/e2e/internal-booking.mjs [screenshot-directory]
 *
 * Needs the app running (AUTH_E2E_BASE, default http://localhost:3200) against a DEVELOPMENT sign-in instance
 * and the test backend. It makes one test person ("+clerk_test@example.com": no email is sent) with a new
 * company, works through Sales › Internal Booking and the shared workspace, and removes the person.
 *
 * What it checks, in the signed-in app:
 *  - Internal Booking sits between Pipeline and Quotes & Proposals, and opening it makes no draft;
 *  - New booking and New recurring booking each open the workspace with one draft of the right kind,
 *    and a double click makes one draft, not two;
 *  - the workspace highlights Internal Booking for a booking and Quotes & Proposals for a proposal, and
 *    switching the mode moves the highlight without losing the draft;
 *  - its back link returns to where the visit came from, and the browser's Back and Forward behave;
 *  - Quotes & Proposals has no booking creation and lists no booking drafts.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

import {
  assertDevelopment,
  BASE,
  CODE,
  expect,
  makePerson,
  passBotCheck,
  removePerson,
  reporter,
} from "./auth-lib.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const shots = process.argv[2] ?? null;
if (shots) mkdirSync(shots, { recursive: true });

const run = Date.now().toString(36);
const pages = [];
const report = reporter(async (count) => {
  if (!shots) return;
  for (const [index, page] of pages.entries())
    if (!page.isClosed())
      await page
        .screenshot({ path: `${shots}/fail-${count}-page${index}.png` })
        .catch(() => undefined);
});
const browser = await chromium.launch({
  proxy: process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }
    : undefined,
});

const shot = async (page, name) => {
  if (shots)
    await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
};
const path = (page) => {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
};
async function settle(page, test, what, arg, timeout = 30000) {
  await page.waitForFunction(test, arg, { timeout }).catch(() => {
    throw new Error(
      `Timed out waiting for ${what}. At ${page.url().replace(BASE, "")}`,
    );
  });
}
/** The sidebar's highlighted work tab: the link marked as the current page inside the agents panel. */
const activeTab = (page) =>
  page
    .locator(
      'nav[aria-label="Main"] ul[aria-label$="work tabs"] a[aria-current="page"]',
    )
    .first()
    .innerText({ timeout: 10000 })
    .then((text) => text.trim())
    .catch(() => null);
const sidebarTabs = (page) =>
  page
    .locator('nav[aria-label="Main"] ul[aria-label="Sales’s work tabs"] > li')
    .allInnerTexts();
/** The workspace's mode switch is a row of radio inputs inside their labels. */
const chooseMode = (page, name) =>
  page.getByRole("radio", { name }).check({ force: true });
/** The drafts listed, once the list shows the number expected or has had time to: the list is live, so it can lag a moment. */
async function draftRows(page, expected) {
  const rows = page.locator(
    'section[aria-labelledby="drafts-heading"] ul.divide-y > li',
  );
  for (let i = 0; i < 40; i++) {
    const count = await rows.count();
    if (count === expected) return count;
    await page.waitForTimeout(250);
  }
  return rows.count();
}
const workspaceId = (page) => new URL(page.url()).pathname.split("/").pop();
async function openInternalBooking(page) {
  await page.goto(`${BASE}/app/agents/sales/internal-booking`, {
    waitUntil: "networkidle",
  });
  await page
    .getByRole("heading", { name: "Internal Booking", level: 1 })
    .waitFor({ timeout: 30000 });
  // The list has answered once the skeleton is gone.
  await settle(
    page,
    () =>
      !document.querySelector(
        'section[aria-labelledby="drafts-heading"] [aria-busy="true"]',
      ),
    "the drafts list",
  );
}
async function inWorkspace(page) {
  await settle(
    page,
    () => /\/app\/agents\/sales\/book\/[^/?]+/.test(location.pathname),
    "the workspace to open",
  );
  await page
    .getByText(/Draft saved|Unsaved changes|Saving…/)
    .first()
    .waitFor({ timeout: 30000 });
}

const owner = await makePerson(
  run,
  "booking",
  `Tidy-booking-Harbor-${run}-91`,
  "Brooke Owner",
);
try {
  await assertDevelopment();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await passBotCheck(ctx);
  ctx.on("page", (page) => pages.push(page));
  const page = await ctx.newPage();
  const company = `Booking Check ${run}`;

  await report.check("signs in and creates a company", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Password", { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await settle(
      page,
      () =>
        !location.pathname.startsWith("/login") ||
        document.querySelector("h1")?.textContent === "Confirm it is you",
      "the sign-in to answer",
    );
    if (
      (await page.locator("h1").first().innerText()) === "Confirm it is you"
    ) {
      await page.getByLabel("Code").fill(CODE);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    await page.getByLabel("Company name").waitFor({ timeout: 30000 });
    await page.getByLabel("Company name").fill(company);
    await page.getByLabel("Time zone").fill("America/Chicago");
    await page
      .getByRole("checkbox", { name: /I accept the/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Create company" }).click();
    // A new company opens on setup; Save and exit opens the workspace without starting or switching on anything.
    await page
      .getByRole("button", { name: "Save and exit" })
      .first()
      .click({ timeout: 45000 });
    await page
      .getByRole("button", { name: /Account menu/ })
      .waitFor({ timeout: 45000 });
  });

  await report.check(
    "Internal Booking sits between Pipeline and Quotes & Proposals, is highlighted, and opening it makes no draft",
    async () => {
      await openInternalBooking(page);
      const tabs = (await sidebarTabs(page))
        .map((text) => text.trim())
        .filter(Boolean);
      const at = tabs.indexOf("Internal Booking");
      expect(
        at > 0 &&
          tabs[at - 1] === "Pipeline" &&
          tabs[at + 1] === "Quotes & Proposals",
        `Sales tabs were: ${tabs.join(" | ")}`,
      );
      expect(
        (await activeTab(page)) === "Internal Booking",
        `Highlighted: ${await activeTab(page)}`,
      );
      expect(
        (await page.title()).startsWith("Internal Booking"),
        `Title: ${await page.title()}`,
      );
      await page.getByText("No booking drafts yet").waitFor({ timeout: 15000 });
      // Opening it again, and reloading, still makes nothing.
      await page.reload({ waitUntil: "networkidle" });
      await openInternalBooking(page);
      await page.getByText("No booking drafts yet").waitFor({ timeout: 15000 });
      await shot(page, "01-internal-booking-empty");
    },
  );

  let oneTime = "";
  await report.check(
    "New booking opens the workspace in one-time mode, under Internal Booking",
    async () => {
      await page
        .getByRole("button", { name: "New booking", exact: true })
        .first()
        .click();
      await inWorkspace(page);
      oneTime = workspaceId(page);
      expect(path(page).endsWith("?from=internal-booking"), `At ${path(page)}`);
      expect(
        (await activeTab(page)) === "Internal Booking",
        `Highlighted: ${await activeTab(page)}`,
      );
      await page
        .getByText("One-time booking", { exact: true })
        .waitFor({ timeout: 10000 });
      const crumbs = await page
        .locator('nav[aria-label="Breadcrumb"]')
        .first()
        .innerText();
      expect(
        /Sales\s*›?\s*Internal Booking/.test(crumbs.replace(/\n/g, " ")),
        `Breadcrumbs: ${crumbs}`,
      );
      expect(
        (await page.title()).includes("Internal Booking"),
        `Title: ${await page.title()}`,
      );
      await shot(page, "02-workspace-booking");
    },
  );

  await report.check(
    "switching to a proposal moves the highlight to Quotes & Proposals, and back again, keeping the draft",
    async () => {
      await chooseMode(page, "Prepare proposal");
      await settle(
        page,
        () =>
          document
            .querySelector(
              'nav[aria-label="Main"] ul[aria-label$="work tabs"] a[aria-current="page"]',
            )
            ?.textContent?.trim() === "Quotes & Proposals",
        "the highlight to move to Quotes & Proposals",
      );
      expect(
        workspaceId(page) === oneTime,
        "The draft changed when the mode changed.",
      );
      await page.getByText("Draft saved").first().waitFor({ timeout: 30000 });
      await chooseMode(page, "Book service");
      await settle(
        page,
        () =>
          document
            .querySelector(
              'nav[aria-label="Main"] ul[aria-label$="work tabs"] a[aria-current="page"]',
            )
            ?.textContent?.trim() === "Internal Booking",
        "the highlight to return to Internal Booking",
      );
      await page.getByText("Draft saved").first().waitFor({ timeout: 30000 });
    },
  );

  await report.check(
    "the back link returns to Internal Booking, which lists the draft; Back and Forward behave",
    async () => {
      await page
        .getByRole("link", { name: "Back to Internal Booking" })
        .click();
      await openInternalBooking(page);
      {
        const n = await draftRows(page, 1);
        expect(n === 1, `Drafts listed: ${n}`);
      }
      await page.goBack({ waitUntil: "networkidle" });
      await inWorkspace(page);
      expect(workspaceId(page) === oneTime, `Back opened ${path(page)}`);
      await page.goForward({ waitUntil: "networkidle" });
      await openInternalBooking(page);
      {
        const n = await draftRows(page, 1);
        expect(n === 1, `Back and Forward made a draft: ${n} listed`);
      }
      // Back from the workspace never lands on the page that starts drafts.
      await page.goBack({ waitUntil: "networkidle" });
      await page.goBack({ waitUntil: "networkidle" });
      expect(
        !path(page).startsWith("/app/agents/sales/new"),
        `Back reached ${path(page)}`,
      );
      await openInternalBooking(page);
      {
        const n = await draftRows(page, 1);
        expect(n === 1, `Drafts listed: ${n}`);
      }
    },
  );

  await report.check("Continue resumes the same draft", async () => {
    await page
      .locator('section[aria-labelledby="drafts-heading"] ul.divide-y > li a')
      .first()
      .click();
    await inWorkspace(page);
    expect(workspaceId(page) === oneTime, `Continue opened ${path(page)}`);
    await page.getByRole("link", { name: "Back to Internal Booking" }).click();
    await openInternalBooking(page);
  });

  await report.check(
    "New recurring booking makes one recurring draft, even when double-clicked",
    async () => {
      await page
        .getByRole("button", { name: "New recurring booking" })
        .dblclick();
      await inWorkspace(page);
      await page
        .getByText("Recurring booking", { exact: true })
        .waitFor({ timeout: 10000 });
      await page
        .getByRole("link", { name: "Back to Internal Booking" })
        .click();
      await openInternalBooking(page);
      {
        const n = await draftRows(page, 2);
        expect(n === 2, `Drafts listed: ${n}`);
      }
      await page
        .getByText("Recurring", { exact: false })
        .first()
        .waitFor({ timeout: 10000 });
      await shot(page, "03-internal-booking-drafts");
    },
  );

  await report.check(
    "Quotes & Proposals keeps quotes and proposals, has no booking creation and lists no booking drafts",
    async () => {
      await page.goto(`${BASE}/app/agents/sales/quotes-proposals`, {
        waitUntil: "networkidle",
      });
      await page
        .getByRole("heading", { name: "Quotes & Proposals", level: 1 })
        .waitFor({ timeout: 30000 });
      expect(
        (await activeTab(page)) === "Quotes & Proposals",
        `Highlighted: ${await activeTab(page)}`,
      );
      expect(
        await page.getByRole("link", { name: "New proposal" }).isVisible(),
        "New proposal is missing.",
      );
      expect(
        (await page.getByText("One-time visit").count()) === 0,
        "The one-time booking card is still here.",
      );
      expect(
        (await page.getByRole("link", { name: /Book service/ }).count()) === 0,
        "Book service is still here.",
      );
      await chooseMode(page, "Proposal drafts");
      await page
        .getByText("No proposal drafts in progress")
        .waitFor({ timeout: 15000 });
      await shot(page, "04-quotes-proposals");
    },
  );

  await report.check(
    "a proposal started here belongs to Quotes & Proposals and returns there",
    async () => {
      await page.getByRole("link", { name: "New proposal" }).click();
      await inWorkspace(page);
      expect(
        (await activeTab(page)) === "Quotes & Proposals",
        `Highlighted: ${await activeTab(page)}`,
      );
      await page
        .getByRole("link", { name: "Back to Quotes & Proposals" })
        .click();
      await page
        .getByRole("heading", { name: "Quotes & Proposals", level: 1 })
        .waitFor({ timeout: 30000 });
      await openInternalBooking(page);
      {
        const n = await draftRows(page, 2);
        expect(n === 2, `A proposal appeared among booking drafts: ${n}`);
      }
    },
  );

  await report.check(
    "Internal Booking and the workspace are usable on a phone",
    async () => {
      const phone = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        storageState: await ctx.storageState(),
      });
      await passBotCheck(phone);
      const mobile = await phone.newPage();
      pages.push(mobile);
      await openInternalBooking(mobile);
      const overflow = await mobile.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow <= 1, `The page scrolls sideways by ${overflow}px.`);
      await mobile
        .getByRole("button", { name: "New booking", exact: true })
        .first()
        .isVisible();
      await shot(mobile, "05-phone-internal-booking");
      await mobile
        .locator('section[aria-labelledby="drafts-heading"] ul.divide-y > li a')
        .first()
        .click();
      await inWorkspace(mobile);
      await shot(mobile, "06-phone-workspace");
      await phone.close();
    },
  );
} finally {
  await removePerson(owner.id);
  await browser.close();
}
process.exit(report.done() ? 1 : 0);
