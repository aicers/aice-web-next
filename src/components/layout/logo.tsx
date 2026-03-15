import Image from "next/image";

import { cn } from "@/lib/utils";

interface LogoProps {
  /** Show only the icon (no text). Used in collapsed sidebar. */
  collapsed?: boolean;
  className?: string;
}

export function Logo({ collapsed = false, className }: LogoProps) {
  if (collapsed) {
    return (
      <Image
        src="/logo-icon.svg"
        alt="Clumit Security"
        width={26}
        height={28}
        className={cn("shrink-0", className)}
      />
    );
  }

  return (
    <span className={cn("inline-flex h-7", className)}>
      <Image
        src="/logo.svg"
        alt="Clumit Security"
        width={204}
        height={28}
        className="h-7 w-auto [[data-theme=gray-dark]_&]:hidden"
        priority
      />
      <Image
        src="/logo-dark.svg"
        alt="Clumit Security"
        width={204}
        height={28}
        className="hidden h-7 w-auto [[data-theme=gray-dark]_&]:block"
        priority
      />
    </span>
  );
}
