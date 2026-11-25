#!/usr/bin/env node
/**
 * A short voice sample for review before a batch is narrated: the same line read once per spelling given,
 * so the Owner can pick how "Selestial" should sound. Writes tutorials/build/voice-sample/<label>.mp3.
 *
 *   ELEVENLABS_API_KEY=... node tutorials/scripts/voice-sample.mjs "Selestial" "Celestial"
 *
 * The key is read from the environment (or injected by the network proxy) and never written anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadVoice, ROOT, speak } from "./lib.mjs";

const spellings = process.argv.slice(2);
if (!spellings.length) throw new Error('Give one or more spellings, for example "Selestial" "Celestial".');
const voice = loadVoice();
const out = join(ROOT, "tutorials/build/voice-sample");
mkdirSync(out, { recursive: true });
for (const word of spellings) {
  const text = `Welcome to ${word}. Let's get your company set up, so your agents can start on real work. It only takes a minute.`;
  const body = await speak(voice, text, { raw: true });
  const file = join(out, `${word.toLowerCase().replace(/[^a-z]+/g, "-")}.mp3`);
  writeFileSync(file, Buffer.from(body.audio_base64, "base64"));
  console.log(`+ ${file} (${text.length} characters)`);
}
