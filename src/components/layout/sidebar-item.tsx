"use client";

import { Loader2, type LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface SidebarItemProps {
  href: string;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  collapsed?: boolean;
  /**
   * Pending navigation feedback (#751). The Detection item sets this
   * while its blocking SSR query is in flight (via
   * `useDetectionReturnNav`'s `isPending`): the item adopts the active
   * highlight immediately on click and swaps its icon for a spinner, so
   * the click registers visibly before navigation commits. Independent
   * of `active`, which only flips once `usePathname()` updates after
   * the route resolves.
   */
  pending?: boolean;
  /**
   * Render as an external anchor (new tab) rather than the in-app i18n
   * `Link`. Used for the "Open AI analyses" deep link into aimer-web,
   * whose target is an absolute bridge URL, not an internal route.
   */
  external?: boolean;
  /**
   * Optional click handler for the in-app `Link` (ignored when
   * `external`). The Detection item uses this to intercept a plain
   * left-click and reconstruct the last Detection URL on an SPA return
   * (#668); calling `preventDefault()` lets it route elsewhere while
   * leaving modifier-clicks (open-in-new-tab) on the bare `href`.
   */
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}

export function SidebarItem({
  href,
  icon: Icon,
  label,
  active = false,
  collapsed = false,
  external = false,
  pending = false,
  onClick,
}: SidebarItemProps) {
  // A pending click adopts the active highlight immediately so the menu
  // lights up before navigation commits; `active` itself only flips
  // once `usePathname()` updates after the route resolves.
  const highlighted = active || pending;
  const className = cn(
    "group relative flex h-12 items-center gap-3 px-4 text-base font-medium transition-colors",
    highlighted
      ? "text-[var(--sidebar-fg)]"
      : "text-[var(--sidebar-muted)] hover:text-[var(--sidebar-fg)]",
    collapsed && "justify-center px-0",
  );
  const inner = (
    <>
      {/* Active indicator — blue left border bar */}
      {highlighted && (
        <span className="absolute top-0 left-0 h-full w-1 rounded-r-lg bg-[var(--sidebar-active)]" />
      )}
      {/* Active glow — radial gradient from left */}
      {highlighted && (
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at left center, rgba(21, 110, 242, 0.29) 0%, transparent 100%)",
          }}
        />
      )}
      {pending ? (
        <Loader2
          className={cn(
            "relative z-10 size-5 shrink-0 animate-spin",
            collapsed && "size-6",
          )}
          aria-hidden="true"
        />
      ) : (
        <Icon
          className={cn("relative z-10 size-5 shrink-0", collapsed && "size-6")}
        />
      )}
      {!collapsed && <span className="relative z-10">{label}</span>}
    </>
  );
  const linkContent = external ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {inner}
    </a>
  ) : (
    <Link
      href={href}
      className={className}
      onClick={onClick}
      aria-busy={pending || undefined}
    >
      {inner}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return linkContent;
}
