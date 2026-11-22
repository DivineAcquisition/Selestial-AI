import { IntegrationMark } from "@/components/app/integration-mark";
import { LogoMark } from "@/components/brand/logo";
import { INTEGRATIONS as CATALOG } from "@/lib/app/integrations";
import { isLive } from "@/lib/marketing/integrations-page";
import { cn } from "@/lib/utils";

/**
 * The tools around the hub, clockwise from the top. Whether each is live is never written here: it comes
 * from the server's list of built integrations (`isLive`), so the picture can't claim more than the product.
 */
export const HUB_IDS = ["quo", "stripe", "gmail", "quickbooks-online", "google-calendar", "jobber", "meta-lead-ads", "google-drive", "housecall-pro", "indeed", "google-ads", "outlook"] as const;

/** Where the ring sits and where the hub's edge is, in the drawing's 100 × 100 space. */
const RING = 40;
const HUB_EDGE = 12;
const NODE_EDGE = 6;

export type HubNode = { id: string; name: string; live: boolean; x: number; y: number };

export function hubNodes(ids: readonly string[] = HUB_IDS): HubNode[] {
  return ids.map((id, index) => {
    const angle = (index / ids.length) * Math.PI * 2 - Math.PI / 2;
    const name = CATALOG.find((item) => item.id === id)?.name ?? id;
    return { id, name, live: isLive(id), x: 50 + Math.cos(angle) * RING, y: 50 + Math.sin(angle) * RING };
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
 * Selestial in the middle, the tools it connects to around it, each with a line into the hub. A live
 * connection has a solid line with a pulse running in; one that is coming soon has a dashed line and says
 * so. Still for anyone who asks for reduced motion.
 */
export function IntegrationHub({ className }: { className?: string }) {
  const nodes = hubNodes();
  const live = nodes.filter((node) => node.live);
  const soon = nodes.filter((node) => !node.live);
  return (
    <figure className={cn("mx-auto w-full max-w-[22rem] sm:max-w-[34rem]", className)}>
      <div className="relative aspect-square w-full">
        <div aria-hidden className="absolute inset-[22%] rounded-full bg-brand-500/20 blur-3xl" />
        <div aria-hidden className="absolute inset-[9%] rounded-full border border-dashed border-brand-500/15" />

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
                <path d={d} stroke="url(#hub-line)" strokeOpacity={0.35} strokeWidth={0.45} strokeLinecap="round" fill="none" />
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
              </g>
            ) : (
              <path key={node.id} d={d} className="stroke-muted-foreground/40" strokeWidth={0.4} strokeDasharray="1 1.6" strokeLinecap="round" fill="none" />
            );
          })}
        </svg>

        {nodes.map((node) => (
          <div key={node.id} className="absolute" style={{ left: `${node.x}%`, top: `${node.y}%`, transform: "translate(-50%, -50%)" }} title={node.live ? node.name : `${node.name} (coming soon)`}>
            <span className="relative block">
              <IntegrationMark id={node.id} size="lg" className={cn("sm:size-14 sm:rounded-2xl", node.live ? "shadow-[0_14px_30px_-14px_rgba(81,38,199,0.6)]" : "opacity-90")} />
              {node.live ? <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background" /> : null}
            </span>
          </div>
        ))}

        <div className="absolute inset-0 grid place-items-center">
          <span className="relative grid place-items-center">
            <span aria-hidden className="absolute inset-[-14%] rounded-[30px] border border-brand-500/30 motion-safe:animate-pulse" />
            <span className="relative rounded-[24px] bg-card p-2.5 shadow-[0_30px_60px_-24px_rgba(104,56,239,0.75)] ring-1 ring-border">
              <LogoMark className="size-14 sm:size-20" />
            </span>
          </span>
        </div>
      </div>

      <figcaption className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-6 rounded-full bg-brand-500" />
          Live today
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="w-6 border-t border-dashed border-muted-foreground/60" />
          Coming soon
        </span>
        <span className="sr-only">
          Selestial connects to: {live.map((node) => node.name).join(", ")}. Coming soon: {soon.map((node) => node.name).join(", ")}.
        </span>
      </figcaption>
    </figure>
  );
}
