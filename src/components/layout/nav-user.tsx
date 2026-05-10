"use client";

import { LogOut, User } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { readCsrfToken } from "@/components/session/session-extension-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

interface NavUserProps {
  username?: string;
  collapsed?: boolean;
}

function getInitials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

export function NavUser({ username, collapsed = false }: NavUserProps) {
  const t = useTranslations();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const displayName = username ?? t("settings.profile");
  const initials = username ? getInitials(username) : "U";

  // Wire Sign Out to the existing `/api/auth/sign-out` flow. The
  // `DropdownMenuItem` was previously a no-op (no `onClick`, no
  // `Link`, no `form` action), which left the dropdown listed as a
  // sign-out path that didn't actually sign anyone out. The forced
  // re-auth flow (#393 Task A) and the analyst-facing recovery from a
  // 401 both rely on this endpoint, so it must work from the menu.
  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const csrfToken = readCsrfToken();
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: csrfToken ? { "x-csrf-token": csrfToken } : {},
      });
    } catch {
      // Best-effort sign-out; redirect regardless so the UI is not
      // wedged on the dashboard if the request fails.
    } finally {
      router.push("/sign-in?reason=signed-out");
    }
  }, [router, signingOut]);

  const trigger = (
    <DropdownMenuTrigger
      className={cn(
        "flex w-full items-center gap-3 rounded-lg bg-[var(--sidebar-account-bg)] p-3 text-sm font-medium text-[var(--sidebar-fg)] transition-colors",
        "hover:brightness-125",
        collapsed && "justify-center rounded-full bg-transparent p-0",
      )}
    >
      <Avatar
        className={cn(
          "shrink-0 bg-primary text-primary-foreground",
          collapsed ? "size-9" : "size-10",
        )}
      >
        <AvatarFallback className="bg-primary text-sm font-medium text-primary-foreground">
          {initials}
        </AvatarFallback>
      </Avatar>
      {!collapsed && <span className="truncate">{displayName}</span>}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{displayName}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent side="right" align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <User className="mr-2 h-4 w-4" />
            {t("settings.profile")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
          disabled={signingOut}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {t("common.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
