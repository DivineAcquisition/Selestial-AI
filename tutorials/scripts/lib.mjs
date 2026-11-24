/** Shared by the tutorial production scripts. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname;

export function loadStoryboard(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`"${id}" is not a tutorial id.`);
  const board = JSON.parse(readFileSync(join(ROOT, "tutorials/storyboards", `${id}.json`), "utf8"));
  if (board.tutorial !== id) throw new Error(`The storyboard names ${board.tutorial}, not ${id}.`);
  return board;
}

/** The series voice (tutorials/voice/voice.json), or a storyboard's own when it names one. */
export function loadVoice(board) {
  if (board && board.voice && board.voice !== "default") return board.voice;
  return JSON.parse(readFileSync(join(ROOT, "tutorials/voice/voice.json"), "utf8"));
}

/** Applies the voice's `say` spellings. Each must keep the length, so character timings still match the written text. */
export function spoken(voice, text) {
  let out = text;
  for (const [written, said] of Object.entries(voice.say ?? {})) {
    if (written.length !== said.length) throw new Error(`"${said}" must have as many characters as "${written}".`);
    out = out.split(written).join(said);
  }
  return out;
}

/**
 * One ElevenLabs request: speech with character timings. The key comes from ELEVENLABS_API_KEY, or the network
 * proxy injects it (then any placeholder value is sent and replaced). Returns the parsed body.
 */
export async function speak(voice, text, { previous, next, raw = false } = {}) {
  const key = process.env.ELEVENLABS_API_KEY || "proxy-injected";
  const say = raw ? text : spoken(voice, text);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}/with-timestamps?output_format=${voice.outputFormat ?? "mp3_44100_128"}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: say, model_id: voice.model, voice_settings: voice.settings, previous_text: previous && spoken(voice, previous), next_text: next && spoken(voice, next) }),
  });
  if (!response.ok) throw new Error(`ElevenLabs refused the request: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  // Timings are for the spoken spelling; the written text has the same length, so put its characters back.
  if (!raw && body.alignment) body.alignment.characters = [...text];
  return body;
}

export const buildDir = (board) => join(ROOT, "tutorials/build", board.tutorial, `v${board.version}`);

/** Seconds as a WebVTT timestamp. */
export function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * Caption cues for one scene from the voice's character timings: whole sentences, split at commas when a
 * cue would exceed two lines of about 42 characters. Times are relative to the scene's narration.
 */
export function cues(text, alignment, maxChars = 84) {
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  const joined = chars.join("");
  const pieces = [];
  let from = 0;
  const pushUntil = (to) => {
    const raw = joined.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const piece = raw.trim();
    if (piece) pieces.push({ text: piece, a: from + lead, b: from + lead + piece.length - 1 });
    from = to;
  };
  const sentences = joined.match(/[^.!?]+[.!?]+["']?\s*|[^.!?]+$/g) ?? [joined];
  let cursor = 0;
  for (const sentence of sentences) {
    const end = cursor + sentence.length;
    if (sentence.trim().length <= maxChars) pushUntil(end);
    else {
      // Break a long sentence at the comma nearest its middle.
      const commas = [...sentence.matchAll(/,\s/g)].map((m) => cursor + m.index + 1);
      const middle = cursor + sentence.length / 2;
      const at = commas.sort((x, y) => Math.abs(x - middle) - Math.abs(y - middle))[0];
      if (at) pushUntil(at);
      pushUntil(end);
    }
    cursor = end;
  }
  if (joined.trim() !== text.trim()) throw new Error("The timings do not match the narration text.");
  return pieces.map((piece) => ({ text: wrap(piece.text), start: starts[piece.a], end: ends[piece.b] }));
}

/** Two balanced lines when a cue is longer than one. */
function wrap(text, width = 42) {
  if (text.length <= width) return text;
  const words = text.split(" ");
  let best = text;
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const s = Math.abs(a.length - b.length) + (Math.max(a.length, b.length) > width ? 100 : 0);
    if (s < score) {
      score = s;
      best = `${a}\n${b}`;
    }
  }
  return best;
}
