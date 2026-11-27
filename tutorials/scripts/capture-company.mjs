#!/usr/bin/env node
/**
 * Records "Set up your company" from a running local Selestial (NEXT_PUBLIC_TUTORIAL_DEMO=local)
 * and from the branded title cards. Scenes run in order: each one leaves the demo company
 * where the next scene starts.
 *
 *   node tutorials/scripts/capture-company.mjs --base http://127.0.0.1:3100
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { buildDir, loadStoryboard, ROOT } from "./lib.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const base = flag("base", "http://127.0.0.1:3100");
const only = flag("scene", undefined);
const from = flag("from", undefined);
const board = loadStoryboard(flag("id", "setup-company"));
const clips = join(buildDir(board), "clips");
mkdirSync(clips, { recursive: true });

const VIEW = { width: 1440, height: 810 };
const font = readFileSync(join(ROOT, "src/fonts/InterVariable.woff2")).toString("base64");
const logo = `data:image/png;base64,${readFileSync(join(ROOT, "public/brand/selestial-logo-white.png")).toString("base64")}`;
const cardHtml = readFileSync(join(ROOT, "tutorials/scripts/card.html"), "utf8");

/** What must be on screen before the scene's own actions, so loading is cut. */
const READY = {
  create: { role: "textbox", name: "Company name" },
  outcome: { role: "heading", name: "What would you like Selestial to help you accomplish first?" },
  essentials: { role: "heading", name: "Confirm a few essentials" },
  context: { role: "heading", name: "Add what makes your first result useful" },
  build: { role: "heading", name: "Build my workspace" },
  result: { role: "heading", name: "Here's what Selestial prepared" },
};

/** Cursor, highlight and callout, installed in the page itself so the recording shows them. */
async function installOverlay(page) {
  await page.evaluate(() => {
    if (window.__tutorialOverlay) return;
    window.__tutorialOverlay = true;
    const style = document.createElement("style");
    style.textContent = `
      nextjs-portal, [data-nextjs-dev-overlay], .z-floating { display: none !important; }
      #tut-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -4px 0 0 -4px; border-radius: 50%;
        background: rgba(104,56,239,.28); border: 2px solid #6838ef; pointer-events: none; }
      #tut-cursor.down { transform: scale(.7); background: rgba(104,56,239,.5); }
      .tut-ring { position: fixed; z-index: 2147483646; border: 3px solid #8e6df6; border-radius: 12px; pointer-events: none;
        box-shadow: 0 0 0 6px rgba(142,109,246,.22); }
      .tut-note { position: fixed; z-index: 2147483646; max-width: 280px; padding: 8px 12px; border-radius: 10px;
        background: #211a35; color: white; font: 600 14px/1.35 Inter, ui-sans-serif, system-ui, sans-serif;
        pointer-events: none; box-shadow: 0 8px 24px rgba(13,10,24,.28); }
    `;
    document.documentElement.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "tut-cursor";
    document.documentElement.appendChild(cursor);
    addEventListener("mousemove", (e) => { cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cursor.classList.add("down"), true);
    addEventListener("mouseup", () => cursor.classList.remove("down"), true);
    window.__ring = (box, note) => {
      document.querySelectorAll(".tut-ring, .tut-note").forEach((el) => el.remove());
      if (!box) return;
      const ring = document.createElement("div");
      ring.className = "tut-ring";
      Object.assign(ring.style, { left: box.x - 6 + "px", top: box.y - 6 + "px", width: box.width + 12 + "px", height: box.height + 12 + "px" });
      document.documentElement.appendChild(ring);
      if (!note) return;
      const label = document.createElement("div");
      label.className = "tut-note";
      label.textContent = note;
      const left = Math.min(box.x, window.innerWidth - 300);
      const top = box.y > 80 ? box.y - 48 : box.y + box.height + 12;
      Object.assign(label.style, { left: Math.max(12, left) + "px", top: top + "px" });
      document.documentElement.appendChild(label);
    };
  });
}

function locatorOf(page, target) {
  if (typeof target === "string") return page.locator(target).first();
  if (target.role) {
    const root = target.in ? page.getByRole(target.in) : page;
    const found = root.getByRole(target.role, { name: target.name, exact: target.exact ?? false });
    return target.nth === undefined ? found.first() : found.nth(target.nth);
  }
  throw new Error(`Bad target ${JSON.stringify(target)}`);
}

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let started = !from;
for (const scene of board.scenes) {
  if (scene.id === from) started = true;
  if (!started || (only && scene.id !== only)) continue;
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    colorScheme: "light",
    timezoneId: "America/Chicago",
    locale: "en-US",
    // Match the page exactly. Assembly scales this up to 1920×1080, so a larger recording size
    // would leave empty bars around a smaller page.
    recordVideo: { dir: clips, size: VIEW },
  });
  const page = await context.newPage();
  const began = Date.now();
  const cuts = [];
  try {
    if (scene.capture.kind === "card") {
      await page.setContent(cardHtml, { waitUntil: "load" });
      await page.evaluate(
        async (card) => window.render(card),
        { ...scene.capture, font: `data:font/woff2;base64,${font}`, logo },
      );
      await page.waitForTimeout(900);
    } else if (scene.capture.kind === "playwright") {
      await context.addInitScript(() => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          if (String(key).startsWith("selestial:welcome-tutorial:")) return "1";
          return original.call(this, key);
        };
      });
      await page.goto(new URL(scene.capture.start, base).toString(), { waitUntil: "domcontentloaded" });
      await installOverlay(page);
      const ready = scene.capture.ready ?? READY[scene.id];
      if (ready) {
        const locator = locatorOf(page, ready);
        // A dev server can answer the first request with a shell that never hydrates. Reload once.
        const appeared = await locator.waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
        if (!appeared) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await installOverlay(page);
          await locator.waitFor({ timeout: 30000 });
        }
      }
      cuts.push([0, (Date.now() - began) / 1000]);
      const moveTo = async (locator) => {
        const box = await locator.boundingBox();
        if (!box) throw new Error(`Nothing to point at in ${scene.id}.`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
        return box;
      };
      for (const step of scene.capture.actions) {
        if (step.do === "exec") continue;
        await installOverlay(page);
        const at = (Date.now() - began) / 1000;
        if (step.do === "highlight" || step.do === "hover") {
          const box = await moveTo(locatorOf(page, step.target));
          if (step.do === "highlight") await page.evaluate(([b, note]) => window.__ring(b, note), [box, step.note ?? null]);
          await page.waitForTimeout(step.ms ?? 1200);
        } else if (step.do === "click") {
          const locator = locatorOf(page, step.target);
          await moveTo(locator);
          await page.waitForTimeout(280);
          await locator.click();
          await installOverlay(page);
          await page.evaluate(() => window.__ring(null));
        } else if (step.do === "type") {
          const locator = locatorOf(page, step.target);
          await moveTo(locator);
          await locator.click();
          if (step.clear) await locator.fill("");
          await locator.pressSequentially(step.text, { delay: 38 });
        } else if (step.do === "scroll") {
          await locatorOf(page, step.target).scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
        } else if (step.do === "waitFor") {
          await locatorOf(page, step.target).waitFor({ timeout: step.timeout ?? 20000 });
        } else if (step.do === "goto") {
          await page.goto(new URL(step.path, base).toString(), { waitUntil: "domcontentloaded" });
          await installOverlay(page);
        } else if (step.do === "wait" || step.do === "pause") {
          await page.waitForTimeout(step.ms);
        } else throw new Error(`Unknown step "${step.do}" in ${scene.id}.`);
        if (step.cut) cuts.push([at, (Date.now() - began) / 1000]);
      }
      await page.waitForTimeout(350);
    } else throw new Error(`Unknown capture kind ${scene.capture.kind}`);
    const ended = (Date.now() - began) / 1000;
    const video = page.video();
    await context.close();
    const raw = await video.path();
    const target = join(clips, `${scene.id}.webm`);
    renameSync(raw, target);
    writeFileSync(join(clips, `${scene.id}.cuts.json`), JSON.stringify({ end: ended, cuts }, null, 1));
    console.log(`+ ${scene.id} → ${target}`);
  } catch (error) {
    const shot = join(clips, `${scene.id}.failed.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    console.error(`x ${scene.id}: ${error instanceof Error ? error.message : error}`);
    console.error(`  screenshot ${shot}`);
    await context.close().catch(() => undefined);
    await browser.close();
    process.exit(1);
  }
}
await browser.close();
