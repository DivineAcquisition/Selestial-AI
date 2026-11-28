import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { HERO, RECRUITER_PRICE_LINE } from "@/lib/recruiter-offer/content";

export const alt = "Selestial Recruiter — AI recruiting for cleaning companies";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The share card: the Recruiter avatar, the headline and the price, on white with a violet edge. */
export default async function Image() {
  const avatar = await readFile(join(process.cwd(), "public/email/agents/recruiter.png"));
  const src = `data:image/png;base64,${avatar.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#ffffff", padding: "64px 72px", borderLeft: "18px solid #6838ef" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img src={src} width={88} height={88} style={{ borderRadius: 999 }} alt="" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 30, fontWeight: 700, color: "#0f0b1e" }}>Selestial Recruiter</span>
            <span style={{ fontSize: 22, color: "#5126c7" }}>{HERO.eyebrow}</span>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2, color: "#0f0b1e", maxWidth: 980 }}>{HERO.headline}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ display: "flex", fontSize: 28, fontWeight: 700, color: "#ffffff", background: "#6838ef", borderRadius: 14, padding: "10px 22px" }}>{RECRUITER_PRICE_LINE}</span>
          <span style={{ fontSize: 24, color: "#5f5b6b" }}>{HERO.reassurance}</span>
        </div>
      </div>
    ),
    size,
  );
}
