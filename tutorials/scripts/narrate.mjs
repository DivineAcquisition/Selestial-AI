#!/usr/bin/env node
/**
 * Narration for one tutorial, scene by scene, from its storyboard: ElevenLabs speech with character
 * timings, so captions follow the voice exactly. Run during production, never when an owner opens a
 * tutorial. The key is read from ELEVENLABS_API_KEY on the machine that runs this, never from the app.
 *
 *   ELEVENLABS_API_KEY=... node tutorials/scripts/narrate.mjs spreadsheet-prepare-clients
 *
 * Writes tutorials/build/<id>/v<version>/narration/<scene>.mp3 and <scene>.json (the timings), and
 * transcript.txt. A scene whose text has not changed is not generated again.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildDir, loadStoryboard } from "./lib.mjs";

const id = process.argv[2];
if (!id) throw new Error("Name a tutorial: node tutorials/scripts/narrate.mjs <tutorial-id>");
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("Set ELEVENLABS_API_KEY.");

const board = loadStoryboard(id);
const voice = board.voice;
if (!voice?.voiceId) throw new Error(`The storyboard for ${id} has no voice.`);
const out = join(buildDir(board), "narration");
mkdirSync(out, { recursive: true });

/**
 * Spoken form of a line. `voice.say` maps a written word to how it is read. Each replacement must be
 * the same length, so the voice's character timings still land on the written captions.
 */
function spoken(text) {
  let out = text;
  for (const [word, said] of Object.entries(voice.say ?? {})) {
    if (word.length !== said.length) throw new Error(`Say "${word}" as something of the same length so captions stay aligned.`);
    out = out.replaceAll(word, said);
  }
  if (out.length !== text.length) throw new Error("A pronunciation changed the length of the narration.");
  return out;
}

for (const [index, scene] of board.scenes.entries()) {
  const hash = createHash("sha256").update(JSON.stringify([voice, scene.narration])).digest("hex").slice(0, 16);
  const meta = join(out, `${scene.id}.json`);
  if (existsSync(meta) && JSON.parse(readFileSync(meta, "utf8")).hash === hash) {
    console.log(`= ${scene.id} (unchanged)`);
    continue;
  }
  const line = spoken(scene.narration);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: line,
      model_id: voice.model,
      voice_settings: voice.settings,
      // Neighbouring lines keep the delivery even from one scene to the next.
      previous_text: board.scenes[index - 1] ? spoken(board.scenes[index - 1].narration) : undefined,
      next_text: board.scenes[index + 1] ? spoken(board.scenes[index + 1].narration) : undefined,
    }),
  });
  if (!response.ok) throw new Error(`ElevenLabs refused ${scene.id}: ${response.status} ${await response.text()}`);
  const body = await response.json();
  writeFileSync(join(out, `${scene.id}.mp3`), Buffer.from(body.audio_base64, "base64"));
  const alignment = body.alignment;
  const heard = alignment.characters.join("");
  if (heard !== line) throw new Error(`The timings for "${scene.id}" do not match the spoken line.\n${heard}`);
  // Captions keep the written spelling. Lengths match, so each timing still belongs to that character.
  alignment.characters = [...scene.narration];
  const duration = alignment.character_end_times_seconds.at(-1) ?? 0;
  writeFileSync(meta, JSON.stringify({ hash, text: scene.narration, duration, alignment }, null, 1));
  console.log(`+ ${scene.id} ${duration.toFixed(2)}s`);
}

writeFileSync(join(buildDir(board), "transcript.txt"), board.scenes.map((scene) => scene.narration).join("\n\n") + "\n");
console.log(`Transcript: ${join(buildDir(board), "transcript.txt")}`);
