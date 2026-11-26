/**
 * How Care writes, in code. Every fact in a message comes from the record it was given; the tone is the
 * company's (Care Setup). Care says it is the company's assistant the first time it writes on a request, and
 * never signs as a person.
 */
import type { Doc } from "../../_generated/dataModel";

export type Voice = { tone: "warm" | "direct" | "formal"; sender: string; clientName: string; first: boolean };

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function greet(voice: Voice): string {
  const name = firstName(voice.clientName);
  const hello = voice.tone === "formal" ? `Hello ${name},` : voice.tone === "direct" ? `${name},` : `Hi ${name},`;
  return voice.first ? `${hello} this is ${voice.sender}'s assistant.` : hello;
}

export function thanks(voice: Voice): string {
  return voice.tone === "formal" ? "Thank you." : voice.tone === "direct" ? "" : "Thanks!";
}

export function compose(voice: Voice, ...lines: (string | null | undefined | false)[]): string {
  return [greet(voice), ...lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0)].join(" ").replace(/\s+/g, " ").trim();
}

export function placeName(property: Pick<Doc<"properties">, "label" | "address"> | null): string {
  return property ? property.label?.trim() || property.address.line1 : "your home";
}

export function numbered(options: { label: string }[]): string {
  return options.map((option, index) => `${index + 1}) ${option.label}`).join(" ");
}
