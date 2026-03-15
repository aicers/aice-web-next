"use client";

import { LogOut, User } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

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

  const displayName = username ?? t("settings.profile");
  const initials = username ? getInitials(username) : "U";

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
        <DropdownMenuItem>
          <LogOut className="mr-2 h-4 w-4" />
          {t("common.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
