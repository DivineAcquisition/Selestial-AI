/**
 * What each agent that is not released yet will do, for its coming-soon page: a short pitch, a worked
 * example the page animates (something arrives, the agent works it, what comes out), the capabilities it
 * will have under the tabs already in the sidebar, and what is usable today. Plain words, no promised dates
 * and no numbers presented as results: every figure in a scene is an example and the page says so.
 */
import type { AgentId } from "./navigation";

import type { MockKind } from "@/components/agents/scene";

export type { MockKind };

export type SceneStep = { title: string; detail: string };

export type Capability = {
  /** The sidebar tab this lives under. */
  tab: string;
  title: string;
  detail: string;
  mock: MockKind;
};

export type ComingSoonAgent = {
  id: Extract<AgentId, "marketing">;
  name: string;
  department: string;
  pitch: string;
  /** The worked example: what arrives, how the agent works it, and what it produces. */
  scene: { trigger: SceneStep; work: string[]; outcomes: SceneStep[] };
  capabilities: Capability[];
  /** Parts already usable today, with where to find them. */
  availableNow?: { label: string; detail: string; path: string }[];
  plan: string;
};

export const COMING_SOON: Record<ComingSoonAgent["id"], ComingSoonAgent> = {
  marketing: {
    id: "marketing",
    name: "Marketing",
    department: "Growth",
    pitch: "Fills the quiet days on your calendar: plans campaigns and promotions from your own customers and services, writes them, sends them only to people who agreed to hear from you, and shows what each one booked.",
    scene: {
      trigger: { title: "A slow week ahead", detail: "6 open slots Tuesday to Thursday" },
      work: ["Looks at past customers, service areas and what usually books mid-week", "Picks the customers who agreed to marketing", "Drafts an offer in your voice"],
      outcomes: [
        { title: "Mid-week deep clean offer drafted", detail: "Ready for your approval" },
        { title: "Sent to 140 past customers", detail: "Only those who opted in" },
        { title: "9 bookings traced to it", detail: "Measured from the Sales pipeline" },
      ],
    },
    capabilities: [
      { tab: "Campaigns", title: "Campaigns that fill gaps", detail: "Plans sends around your open capacity, seasons and service areas, and keeps them to people who agreed to marketing.", mock: "calendar" },
      { tab: "Promotions", title: "Offers you control", detail: "Drafts promotions with the limits you set: which services, how much, until when. Nothing goes out without your approval.", mock: "offer" },
      { tab: "Lead Sources", title: "Where customers come from", detail: "Brings Google, referrals, your booking pages and campaigns into one view, so you know what's worth paying for.", mock: "bars" },
      { tab: "Performance", title: "What each campaign booked", detail: "Ties sends to inquiries and bookings Sales handled, instead of opens and clicks.", mock: "progress" },
    ],
    availableNow: [{ label: "Content & Creative", detail: "Create images and short videos for your business with Creative Studio today.", path: "/app/agents/marketing/content-creative" }],
    plan: "Not released yet. We'll say what it comes with when it is.",
  },
};

export function comingSoonAgent(id: string): ComingSoonAgent | null {
  return id in COMING_SOON ? COMING_SOON[id as ComingSoonAgent["id"]] : null;
}
