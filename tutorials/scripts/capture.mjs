#!/usr/bin/env node
/**
 * Records a tutorial's scenes against a running Selestial, with a visible cursor, a highlight ring and an
 * optional callout on the control each step points at. Scenes with "kind": "manual" are recorded by a person
 * (see tutorials/README.md) and placed at tutorials/build/<id>/v<version>/clips/<scene>.mp4.
 *
 *   node tutorials/scripts/capture.mjs <tutorial-id> --base http://localhost:3100 --storage tutorials/.auth/<demo>.json
 *   node tutorials/scripts/capture.mjs <tutorial-id> --scene <scene-id>     (one scene again)
 *   node tutorials/scripts/capture.mjs <tutorial-id> --from <scene-id>      (that scene and the ones after it)
 *
 * Frames come from the browser's own screencast as high-quality JPEGs, so text stays sharp: the page is laid
 * out at the storyboard's viewport (default 1280×720) and drawn at 1.5× pixel density, which is exactly
 * 1920×1080. Frames arrive only when the screen changes; each is held until the next.
 *
 * "kind": "card" scenes are Selestial's own title and closing frames, drawn from tutorials/scripts/card.html.
 *
 * --storage is a Playwright storage state for an authorized demo account holding sample data only. It is
 * never committed (tutorials/.auth is ignored). Waits marked "cut" are left out of the final video.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildDir, loadStoryboard, ROOT } from "./lib.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const args = process.argv.slice(2);
const id = args[0];
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const base = flag("base", process.env.TUTORIAL_BASE ?? "http://localhost:3100");
const storage = flag("storage", undefined);
const only = flag("scene", undefined);
const from = flag("from", undefined);
/** The demo owner's label, from tutorials/.auth/<label>.json, for scene hooks. */
const storageLabel = storage ? storage.replace(/^.*\//, "").replace(/\.json$/, "") : "";

const board = loadStoryboard(id);
const clips = join(buildDir(board), "clips");
mkdirSync(clips, { recursive: true });

const VIEW = board.viewport ?? { width: 1280, height: 720 };
const SCALE = 1920 / VIEW.width;
const FPS = 30;

/** The cursor, a click ripple, a highlight ring with an optional callout, and a corner tag, drawn in the page. */
const OVERLAY = `
(() => {
  if (!document.documentElement) return;
  if (window.__ring && document.getElementById("tut-cursor")) return;
  const style = document.createElement("style");
  style.textContent = \`
    nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }
    #tut-cursor { position: fixed; z-index: 2147483647; left: -40px; top: -40px; width: 22px; height: 22px; pointer-events: none;
      transform: translate(-3px, -2px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    .tut-ripple { position: fixed; z-index: 2147483646; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
      border: 2px solid #6838ef; background: rgba(104,56,239,.18); pointer-events: none; animation: tut-ripple .5s ease-out forwards; }
    @keyframes tut-ripple { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
    .tut-ring { position: fixed; z-index: 2147483645; border: 2.5px solid #6838ef; border-radius: 12px; pointer-events: none;
      box-shadow: 0 0 0 5px rgba(104,56,239,.16); animation: tut-in .25s ease-out; }
    .tut-note { position: fixed; z-index: 2147483645; max-width: 320px; padding: 7px 11px; border-radius: 10px; pointer-events: none;
      background: #1c1530; color: #fff; font: 600 13px/1.35 Inter, ui-sans-serif, system-ui, sans-serif; box-shadow: 0 6px 20px rgba(20,10,50,.28);
      animation: tut-in .25s ease-out; }
    .tut-tag { position: fixed; z-index: 2147483645; top: 12px; right: 12px; padding: 5px 10px; border-radius: 999px; pointer-events: none;
      background: rgba(28,21,48,.88); color: #fff; font: 600 12px/1 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: .01em; }
    @keyframes tut-in { from { opacity: 0; transform: translateY(3px) } to { opacity: 1; transform: none } }
  \`;
  document.documentElement.appendChild(style);
  const cursor = document.createElement("div");
  cursor.id = "tut-cursor";
  cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8.2-6.1 1.3L8 17.4z" fill="#fff" stroke="#14101f" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cursor);
  addEventListener("mousemove", (e) => { cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div");
    r.className = "tut-ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 600);
  }, true);
  window.__ring = (box, note) => {
    document.querySelectorAll(".tut-ring,.tut-note").forEach((el) => el.remove());
    if (!box) return;
    const ring = document.createElement("div");
    ring.className = "tut-ring";
    Object.assign(ring.style, { left: box.x - 6 + "px", top: box.y - 6 + "px", width: box.width + 12 + "px", height: box.height + 12 + "px" });
    document.documentElement.appendChild(ring);
    if (note) {
      const n = document.createElement("div");
      n.className = "tut-note"; n.textContent = note;
      document.documentElement.appendChild(n);
      const below = box.y + box.height + 14 + n.offsetHeight < innerHeight;
      n.style.top = (below ? box.y + box.height + 14 : box.y - n.offsetHeight - 14) + "px";
      n.style.left = Math.max(12, Math.min(box.x, innerWidth - n.offsetWidth - 12)) + "px";
    }
  };
  window.__tag = (text) => {
    document.querySelectorAll(".tut-tag").forEach((el) => el.remove());
    if (!text) return;
    const t = document.createElement("div");
    t.className = "tut-tag"; t.textContent = text;
    document.documentElement.appendChild(t);
  };
})();`;

/** A still card (title or closing), rendered from card.html at 1920×1080 and held for `seconds`. */
async function card(browser, scene) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const html = readFileSync(join(ROOT, "tutorials/scripts/card.html"), "utf8");
  await page.setContent(html, { waitUntil: "load" });
  const logo = `data:image/svg+xml;base64,${readFileSync(join(ROOT, "public/brand/selestial-logo-white.svg")).toString("base64")}`;
  const font = `data:font/woff2;base64,${readFileSync(join(ROOT, "src/fonts/InterVariable.woff2")).toString("base64")}`;
  await page.evaluate(({ card, logo, font }) => window.render({ ...card, logo, font }), { card: scene.capture, logo, font });
  await page.waitForTimeout(300);
  const png = join(clips, `${scene.id}.png`);
  await page.screenshot({ path: png });
  await page.close();
  const seconds = scene.capture.seconds ?? 6;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", png, "-t", String(seconds), "-r", String(FPS), "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", join(clips, `${scene.id}.mp4`)]);
  writeFileSync(join(clips, `${scene.id}.cuts.json`), JSON.stringify({ end: seconds, cuts: [] }));
  console.log(`+ ${scene.id} (card)`);
}

async function record(browser, scene) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, storageState: storage ? resolve(storage) : undefined, reducedMotion: "no-preference" });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  await page.goto(new URL(scene.capture.start, base).toString(), { waitUntil: "networkidle" });
  await page.evaluate(OVERLAY);
  await page.waitForTimeout(scene.capture.settle ?? 1200);
  const park = scene.capture.cursor ?? { x: VIEW.width * 0.62, y: VIEW.height * 0.55 };
  await page.mouse.move(park.x, park.y);

  // Screencast frames, written as they come; loading is never part of the tutorial, so recording starts here.
  const frames = mkdtempSync(join(tmpdir(), `tut-${scene.id}-`));
  const list = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = join(frames, `${String(list.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    list.push({ file, at: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  const began = Date.now() / 1000;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  // Nudge one frame so the clip starts on the settled page.
  await page.mouse.move(park.x + 1, park.y);
  const cuts = [];
  const now = () => Date.now() / 1000 - began;
  /** A CSS/text selector, or { role, name } where a name written "/like this/" is a regular expression. */
  const nameOf = (name) => (typeof name === "string" && /^\/.+\/$/.test(name) ? new RegExp(name.slice(1, -1)) : name);
  const locate = (target) => (typeof target === "string" ? page.locator(target) : page.getByRole(target.role, { name: nameOf(target.name), exact: target.exact ?? false })).nth(target.nth ?? 0);
  const moveTo = async (locator) => {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const box = await locator.boundingBox();
    if (!box) throw new Error(`Nothing to point at in ${scene.id}.`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
    return box;
  };

  for (const step of scene.capture.actions ?? []) {
    const at = now();
    // A page can replace itself (a sign-in check, a redirect): put the overlay back before every step.
    await page.evaluate(OVERLAY).catch(() => undefined);
    try {
      await perform(step);
    } catch (error) {
      // Keep what the page looked like when the step failed, to fix the storyboard.
      await page.screenshot({ path: join(clips, `${scene.id}.failed.png`) }).catch(() => undefined);
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      await context.close();
      rmSync(frames, { recursive: true, force: true });
      throw new Error(`Scene "${scene.id}", step ${JSON.stringify(step)}: ${String(error?.message ?? error).split("\n")[0]} (screenshot: ${scene.id}.failed.png)`);
    }
    if (step.cut) cuts.push([at, now()]);
  }

  async function perform(step) {
    if (step.do === "highlight") {
      const box = await moveTo(locate(step.target));
      await page.evaluate(([b, note]) => window.__ring(b, note), [box, step.note ?? null]);
      await page.waitForTimeout(step.ms ?? 1400);
      if (!step.keep) await page.evaluate(() => window.__ring(null));
    } else if (step.do === "ring") {
      const box = await locate(step.target).boundingBox();
      await page.evaluate(([b, note]) => window.__ring(b, note), [box, step.note ?? null]);
      await page.waitForTimeout(step.ms ?? 1400);
      if (!step.keep) await page.evaluate(() => window.__ring(null));
    } else if (step.do === "click") {
      await moveTo(locate(step.target));
      await page.waitForTimeout(280);
      await page.evaluate(() => window.__ring(null));
      await locate(step.target).click();
      await page.waitForTimeout(step.ms ?? 450);
    } else if (step.do === "type") {
      await moveTo(locate(step.target));
      await locate(step.target).click();
      if (step.clear) await locate(step.target).fill("");
      await locate(step.target).pressSequentially(step.text, { delay: step.delay ?? 55 });
      await page.waitForTimeout(step.ms ?? 300);
    } else if (step.do === "fill") {
      await locate(step.target).fill(step.text);
    } else if (step.do === "press") {
      await page.keyboard.press(step.key);
      await page.waitForTimeout(step.ms ?? 300);
    } else if (step.do === "hover") {
      await moveTo(locate(step.target));
      await page.waitForTimeout(step.ms ?? 600);
    } else if (step.do === "upload") {
      await page.locator(step.target).first().setInputFiles([step.file].flat().map((file) => join(ROOT, file)));
    } else if (step.do === "scroll") {
      if (step.target) await locate(step.target).scrollIntoViewIfNeeded();
      else await page.mouse.wheel(0, step.y ?? 400);
      await page.waitForTimeout(step.ms ?? 700);
    } else if (step.do === "waitFor") {
      await locate(step.target).waitFor({ state: step.state ?? "visible", timeout: step.timeout ?? 30000 });
      await page.waitForTimeout(step.ms ?? 300);
    } else if (step.do === "tag") {
      await page.evaluate((text) => window.__tag(text), step.text ?? null);
    } else if (step.do === "goto") {
      await page.goto(new URL(step.path, base).toString(), { waitUntil: "networkidle" });
      await page.evaluate(OVERLAY);
      await page.waitForTimeout(step.ms ?? 900);
    } else if (step.do === "exec") {
      // Demo bookkeeping in the middle of a scene (mark it "cut"), such as giving a new demo company its plan.
      execFileSync(process.execPath, step.args.map((part) => part.replace("{auth}", storageLabel)), { cwd: ROOT, stdio: "inherit" });
    } else if (step.do === "wait" || step.do === "pause") {
      await page.waitForTimeout(step.ms);
    } else throw new Error(`Unknown step "${step.do}" in ${scene.id}.`);
  }
  await page.waitForTimeout(scene.capture.hold ?? 600);
  const end = now();
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await context.close();
  if (!list.length) throw new Error(`No frames were recorded for ${scene.id}.`);

  // Each frame lasts until the next one; the last until the end. Then a constant-rate, high-quality clip.
  const lines = ["ffconcat version 1.0"];
  list.forEach((frame, i) => {
    const next = i + 1 < list.length ? list[i + 1].at : began + end;
    lines.push(`file '${frame.file}'`, `duration ${Math.max(0.001, next - Math.max(frame.at, began)).toFixed(4)}`);
  });
  lines.push(`file '${list.at(-1).file}'`);
  const concat = join(frames, "list.txt");
  writeFileSync(concat, lines.join("\n"));
  // Frames before the screencast's first one would be blank: the clip's clock starts at the first frame.
  const offset = Math.max(0, list[0].at - began);
  const target = join(clips, `${scene.id}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "14", target]);
  rmSync(frames, { recursive: true, force: true });
  writeFileSync(join(clips, `${scene.id}.cuts.json`), JSON.stringify({ end: end - offset, cuts: cuts.map(([a, b]) => [Math.max(0, a - offset), Math.max(0, b - offset)]) }, null, 1));
  console.log(`+ ${scene.id} → ${target} (${(end - offset).toFixed(1)}s, ${list.length} frames)`);
  // Demo bookkeeping after the scene, never on camera (for example, giving a new demo company its plan).
  if (scene.capture.after) execFileSync(process.execPath, scene.capture.after.map((part) => part.replace("{auth}", storageLabel)), { cwd: ROOT, stdio: "inherit" });
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({ proxy: proxy ? { server: proxy, bypass: "localhost,127.0.0.1" } : undefined });
try {
  let reached = !from;
  for (const scene of board.scenes) {
    if (scene.id === from) reached = true;
    if (!reached || (only && scene.id !== only)) continue;
    if (scene.capture.kind === "card") await card(browser, scene);
    else if (scene.capture.kind === "playwright") await record(browser, scene);
  }
} finally {
  await browser.close();
}
