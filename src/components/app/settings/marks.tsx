import { Bell, BotIcon, Mail, MessageSquareText, Building2, Sparkles, HistoryIcon, KeyIcon, PackageOpen, Plug, ScrollTextIcon, ShieldCheck, Users, Wallet, type LucideIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

const ICON: Record<string, LucideIcon> = {
  business: Building2,
  services: PackageOpen,
  people: Users,
  agents: BotIcon,
  messaging: MessageSquareText,
  "company-messages": Mail,
  integrations: Plug,
  ai: Sparkles,
  billing: Wallet,
  security: KeyIcon,
  notifications: Bell,
  compliance: ShieldCheck,
  agreements: ScrollTextIcon,
  activity: HistoryIcon,
  "support-access": ShieldCheck,
};

export function SectionMark({ id, size = "md" }: { id: string; size?: "sm" | "md" | "lg" }) {
  const Icon = ICON[id] ?? Building2;
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 ring-1 ring-brand-500/20", size === "sm" ? "size-7" : size === "md" ? "size-9" : "size-11")}>
      <Icon className={size === "sm" ? "size-4" : "size-5"} />
    </span>
  );
}
