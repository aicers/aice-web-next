import { NextResponse } from "next/server";

import { resetRateLimiter } from "@/lib/rate-limit/limiter";

export async function POST(): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  resetRateLimiter();
  return NextResponse.json({ ok: true });
}
