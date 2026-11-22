import { IntegrationMark } from "@/components/app/integration-mark";
import { LogoMark } from "@/components/brand/logo";
import { AgentMark } from "@/components/marketing/agent-mark";
import { INTEGRATIONS as CATALOG } from "@/lib/app/integrations";
import type { AgentId } from "@/lib/marketing/content";
import { isLive } from "@/lib/marketing/integrations-page";
import { cn } from "@/lib/utils";

/**
 * The tools around the hub, clockwise from the top. Whether each is live is never written here: it comes
 * from the server's list of built integrations (`isLive`), so the picture can't claim more than the product.
 * Field-service platforms (Jobber, Housecall Pro) are left off the picture on purpose: they are import sources,
 * not tools the agents work in, and they stay listed on the integrations page.
 */
export const HUB_IDS = ["quo", "stripe", "gmail", "quickbooks-online", "google-calendar", "meta-lead-ads", "google-drive", "indeed", "google-ads", "outlook"] as const;

/** The four agents, on an inner ring between Selestial and the tools, set between the lines. */
export const HUB_AGENTS: readonly AgentId[] = ["sales", "dispatch", "retention", "recruiter"];

/** Where the rings sit and where the hub's edge is, in the drawing's 100 × 100 space. */
const RING = 40;
const AGENT_RING = 23;
const HUB_EDGE = 11;
const NODE_EDGE = 6;

export type HubNode = { id: string; name: string; live: boolean; x: number; y: number };

export function hubNodes(ids: readonly string[] = HUB_IDS): HubNode[] {
  return ids.map((id, index) => {
    const angle = (index / ids.length) * Math.PI * 2 - Math.PI / 2;
    const name = CATALOG.find((item) => item.id === id)?.name ?? id;
    return { id, name, live: isLive(id), x: 50 + Math.cos(angle) * RING, y: 50 + Math.sin(angle) * RING };
  });
}

/**
 * The agents' places, in degrees clockwise from "3 o'clock": each sits exactly halfway between two tools' lines
 * (ten tools are 36° apart, starting at the top, so the gaps are at odd multiples of 18°), mirrored left and right.
 */
const AGENT_ANGLES = [-36, 36, 144, 216] as const;

function agentSpots() {
  return HUB_AGENTS.map((id, index) => {
    const angle = (AGENT_ANGLES[index] * Math.PI) / 180;
    return { id, x: 50 + Math.cos(angle) * AGENT_RING, y: 50 + Math.sin(angle) * AGENT_RING };
  });
}

/** A point `distance` along the line from (x, y) toward the centre. */
function toward(x: number, y: number, distance: number) {
  const dx = 50 - x;
  const dy = 50 - y;
  const length = Math.hypot(dx, dy);
  return { x: x + (dx / length) * distance, y: y + (dy / length) * distance };
}

/**
 * Selestial at the core, its four agents on an inner ring, and the tools they work in around the edge. A live
 * connection has a solid line with pulses running both ways (news coming in, an agent acting out); one that is
 * coming soon has a dashed line and says so. Everything is still for anyone who asks for reduced motion.
 */
export function IntegrationHub({ className }: { className?: string }) {
  const nodes = hubNodes();
  const agents = agentSpots();
  const live = nodes.filter((node) => node.live);
  const soon = nodes.filter((node) => !node.live);
  return (
    <figure className={cn("mx-auto w-full max-w-[22rem] sm:max-w-[36rem]", className)}>
      <div className="relative aspect-square w-full">
        {/* Atmosphere: a soft glow, and two slowly turning orbit rings. */}
        <div aria-hidden className="absolute inset-[18%] rounded-full bg-brand-500/25 blur-3xl" />
        <div aria-hidden className="absolute inset-[9%] rounded-full border border-dashed border-brand-500/20 motion-safe:animate-hub-orbit" />
        <div aria-hidden className="absolute inset-[27%] rounded-full border border-brand-500/25 motion-safe:animate-hub-orbit-reverse">
          <span className="absolute top-0 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-400 shadow-[0_0_10px_2px_rgba(139,108,246,0.8)]" />
          <span className="absolute bottom-0 left-1/2 size-1 -translate-x-1/2 translate-y-1/2 rounded-full bg-brand-300 shadow-[0_0_8px_2px_rgba(179,158,255,0.7)]" />
        </div>

        <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id="hub-line" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor="#8b6cf6" />
              <stop offset="1" stopColor="#5126c7" />
            </linearGradient>
          </defs>
          {nodes.map((node, index) => {
            const from = toward(node.x, node.y, NODE_EDGE);
            const to = toward(node.x, node.y, RING - HUB_EDGE);
            const d = `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} L ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
            return node.live ? (
              <g key={node.id}>
                <path d={d} stroke="url(#hub-line)" strokeOpacity={0.4} strokeWidth={0.45} strokeLinecap="round" fill="none" />
                <path
                  d={d}
                  stroke="#7c4dff"
                  strokeWidth={0.9}
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray="5 59"
                  strokeDashoffset={64}
                  className="opacity-0 motion-safe:animate-hub-flow motion-safe:opacity-100"
                  style={{ animationDelay: `${(index * 0.53) % 3.6}s` }}
                />
                <path
                  d={d}
                  stroke="#c4b5fd"
                  strokeWidth={0.7}
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray="3 61"
                  className="opacity-0 motion-safe:animate-hub-flow-out motion-safe:opacity-100"
                  style={{ animationDelay: `${(index * 0.53 + 1.8) % 3.6}s` }}
                />
              </g>
            ) : (
              <path key={node.id} d={d} className="stroke-muted-foreground/40" strokeWidth={0.4} strokeDasharray="1 1.6" strokeLinecap="round" fill="none" />
            );
          })}
        </svg>

        {/* The tools. */}
        {nodes.map((node) => (
          <div key={node.id} className="absolute" style={{ left: `${node.x}%`, top: `${node.y}%`, transform: "translate(-50%, -50%)" }} title={node.live ? node.name : `${node.name} (coming soon)`}>
            <span className="relative block">
              <IntegrationMark id={node.id} size="lg" className={cn("sm:size-14 sm:rounded-2xl", node.live ? "shadow-[0_14px_30px_-14px_rgba(81,38,199,0.6)]" : "opacity-80 grayscale-[35%]")} />
              {node.live ? <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background" /> : null}
            </span>
          </div>
        ))}

        {/* The agents, on the inner ring. */}
        {agents.map((agent) => (
          <div key={agent.id} aria-hidden className="absolute" style={{ left: `${agent.x}%`, top: `${agent.y}%`, transform: "translate(-50%, -50%)" }}>
            <span className="relative block rounded-full p-[3px] shadow-[0_10px_28px_-10px_rgba(104,56,239,0.9)] [background:conic-gradient(from_180deg,#6838ef,#b39eff,#6838ef)]">
              <span className="block rounded-full bg-background p-[2px]">
                <AgentMark id={agent.id} size="sm" live />
              </span>
            </span>
          </div>
        ))}

        {/* Selestial at the core: the mark itself, no frame, in a breathing glow. */}
        <div className="absolute inset-0 grid place-items-center">
          <span className="relative grid place-items-center">
            <span aria-hidden className="absolute inset-[-55%] rounded-full bg-[radial-gradient(circle,rgba(124,77,255,0.45),transparent_65%)] motion-safe:animate-pulse" />
            <span aria-hidden className="absolute inset-[-18%] rounded-[30%] border border-brand-400/40 motion-safe:animate-ping [animation-duration:3s]" />
            <LogoMark className="relative size-16 drop-shadow-[0_18px_30px_rgba(81,38,199,0.65)] sm:size-24" />
          </span>
        </div>
      </div>

      <figcaption className="mt-6 grid justify-items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/25 bg-brand-500/[0.06] px-3 py-1.5 text-[13px] text-strong">
          <span aria-hidden className="live-pulse size-2 rounded-full bg-success" />
          Sales, Dispatch, Retention and Recruiter work across every connected tool
        </span>
        <span className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="h-0.5 w-6 rounded-full bg-brand-500" />
            Live today
          </span>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="w-6 border-t border-dashed border-muted-foreground/60" />
            Coming soon
          </span>
        </span>
        <span className="sr-only">
          Selestial connects to: {live.map((node) => node.name).join(", ")}. Coming soon: {soon.map((node) => node.name).join(", ")}.
        </span>
      </figcaption>
    </figure>
  );
}
