#!/usr/bin/env node
/**
 * Narration for one tutorial, scene by scene, from its storyboard: ElevenLabs speech with character
 * timings, so captions follow the voice exactly. Run during production, never when an owner opens a
 * tutorial. The key is read from ELEVENLABS_API_KEY on the machine that runs this, never from the app.
 *
 *   ELEVENLABS_API_KEY=... node tutorials/scripts/narrate.mjs spreadsheet-prepare-clients
 *   NODE_USE_ENV_PROXY=1 node tutorials/scripts/narrate.mjs setup-company     (key injected by the proxy)
 *
 * Writes tutorials/build/<id>/v<version>/narration/<scene>.mp3 and <scene>.json (the timings), and
 * transcript.txt. A line whose words, voice and pronunciations have not changed is never generated again: it is
 * reused from tutorials/build/.narration-cache, whichever tutorial or version first paid for it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildDir, loadStoryboard, loadVoice, ROOT, speak } from "./lib.mjs";

/** Every line ever generated, by content hash (voice, settings, pronunciations, words). Git-ignored with the build. */
const CACHE = join(ROOT, "tutorials/build/.narration-cache");
mkdirSync(CACHE, { recursive: true });
let spent = 0;

const id = process.argv[2];
if (!id) throw new Error("Name a tutorial: node tutorials/scripts/narrate.mjs <tutorial-id>");
const board = loadStoryboard(id);
// The series voice (tutorials/voice/voice.json) unless the storyboard names its own.
const voice = loadVoice(board);
if (!process.env.ELEVENLABS_API_KEY) console.log("ELEVENLABS_API_KEY is not set: the network proxy must supply it (Claude Code cloud sessions do).");
const out = join(buildDir(board), "narration");
mkdirSync(out, { recursive: true });

for (const [index, scene] of board.scenes.entries()) {
  // The cache key is the voice, its pronunciations and the exact words, so only changed lines are paid for again.
  const hash = createHash("sha256").update(JSON.stringify([voice.voiceId, voice.model, voice.settings, voice.say ?? {}, scene.narration])).digest("hex").slice(0, 16);
  const meta = join(out, `${scene.id}.json`);
  if (existsSync(meta) && JSON.parse(readFileSync(meta, "utf8")).hash === hash) {
    console.log(`= ${scene.id} (unchanged)`);
    continue;
  }
  // A line already paid for, in any tutorial or version, is reused from the shared cache.
  const cached = join(CACHE, `${hash}.json`);
  if (existsSync(cached)) {
    copyFileSync(join(CACHE, `${hash}.mp3`), join(out, `${scene.id}.mp3`));
    copyFileSync(cached, meta);
    console.log(`= ${scene.id} (from the cache)`);
    continue;
  }
  // Neighbouring lines keep the delivery even from one scene to the next.
  const body = await speak(voice, scene.narration, { previous: board.scenes[index - 1]?.narration, next: board.scenes[index + 1]?.narration });
  const alignment = body.alignment;
  const duration = alignment.character_end_times_seconds.at(-1) ?? 0;
  writeFileSync(join(CACHE, `${hash}.mp3`), Buffer.from(body.audio_base64, "base64"));
  writeFileSync(cached, JSON.stringify({ hash, text: scene.narration, duration, alignment }, null, 1));
  copyFileSync(join(CACHE, `${hash}.mp3`), join(out, `${scene.id}.mp3`));
  copyFileSync(cached, meta);
  spent += scene.narration.length;
  console.log(`+ ${scene.id} ${duration.toFixed(2)}s (${scene.narration.length} characters)`);
}

writeFileSync(join(buildDir(board), "transcript.txt"), board.scenes.map((scene) => scene.narration).join("\n\n") + "\n");
console.log(`Transcript: ${join(buildDir(board), "transcript.txt")}`);
console.log(`Characters sent to ElevenLabs this run: ${spent}`);
