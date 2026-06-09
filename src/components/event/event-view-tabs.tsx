"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VIEW_MODE_PARAM, VIEW_MODES, type ViewMode } from "@/lib/event";

/**
 * The Event page view-mode toggle (`Events | Statistics | Time Series`).
 *
 * Switching writes `?view=` into the URL — the active filter for each
 * view rides in its own params, so flipping the toggle keeps every
 * view's state and the server component re-reads the URL to render the
 * selected one. Time Series was added here in E5 Part 2.
 */
export function EventViewTabs({ active }: { active: ViewMode }) {
  const t = useTranslations("event.views");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const onChange = (next: string): void => {
    if (next === active) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set(VIEW_MODE_PARAM, next);
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `${pathname}?${query}` : pathname);
    });
  };

  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList aria-busy={pending}>
        {VIEW_MODES.map((mode) => (
          <TabsTrigger key={mode} value={mode}>
            {t(mode)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
