import "server-only";

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { withAuth } from "@/lib/auth/guard";
import {
  DetectionForbiddenError,
  DetectionUnauthorizedError,
} from "@/lib/detection/errors";
import { assemblePcapFile, PcapCapExceededError } from "@/lib/detection/pcap";
import { fetchDetectionPackets } from "@/lib/detection/server-actions";
import { ExternalServiceUnavailableError } from "@/lib/node/errors";
import {
  ReviewForbiddenError,
  ReviewInvalidArgumentError,
} from "@/lib/review/errors";

/**
 * GET /api/detection/pcap?sensor=<id>&requestTime=<RFC3339>
 *
 * Assembles and streams the raw packet capture for a single Detection
 * event as a binary `.pcap` download (`Content-Disposition:
 * attachment`). The handler calls the shared `fetchDetectionPackets`
 * helper — the single `packets` fetch layer, which paginates the
 * `PacketConnection` under hard packet / byte caps — then frames the
 * decoded bytes with `assemblePcapFile` (in-app-confirmed
 * `LINKTYPE_ETHERNET`, per-packet `packetTime` timestamps). Raw bytes
 * are handled entirely server-side; they never pass through client
 * state.
 *
 * A GET (not POST) so the PCAP tab can drive the download with `fetch`
 * and trigger the browser save from the response blob (a plain
 * `<a download>` cannot surface the `404` empty-state body below).
 * Mirrors the CSV export route's `withAuth("detection:read")` guard
 * and error → status mapping.
 *
 * Response shapes:
 * - `200 application/vnd.tcpdump.pcap` — the assembled capture.
 * - `400` — missing / malformed `sensor` or `requestTime`.
 * - `403` — missing permission / customer scope, or a review/BFF
 *   denial.
 * - `404 { code: "no-packet-data" }` — the data store has no packets
 *   stored for this event; no header-only file is served so the tab
 *   can show its empty state instead of saving a useless capture.
 * - `413` — capture exceeds the hard packet / byte cap.
 * - `503` — Giganto unreachable.
 * - `500` — any other failure.
 */
export const GET = withAuth(
  async (request, _context, session) => {
    const url = new URL(request.url);
    const sensor = url.searchParams.get("sensor");
    const requestTime = url.searchParams.get("requestTime");

    if (!sensor || sensor.length === 0) {
      return NextResponse.json(
        { error: "Missing or malformed `sensor`" },
        { status: 400 },
      );
    }
    if (!requestTime || Number.isNaN(Date.parse(requestTime))) {
      return NextResponse.json(
        { error: "Missing or malformed `requestTime`" },
        { status: 400 },
      );
    }

    try {
      const packets = await fetchDetectionPackets(
        session,
        sensor,
        requestTime,
        request.signal,
      );
      if (packets.length === 0) {
        // No stored capture for this event. Serving a 24-byte
        // header-only `.pcap` would download a file that opens empty in
        // Wireshark and looks indistinguishable from a failure, so
        // return a distinct 404 the (fetch-driven) tab maps to its
        // empty state instead.
        return NextResponse.json(
          { error: "No packet data", code: "no-packet-data" },
          { status: 404 },
        );
      }
      const { file, epochFallbackCount } = assemblePcapFile(packets);
      if (epochFallbackCount > 0) {
        // `rfc3339ToEpochMicros` stamps unparseable timestamps at the
        // epoch rather than aborting the download; log once here (the
        // only layer holding sensor / event context) so a 1970-stamped
        // packet is diagnosable instead of silent.
        console.warn(
          `[detection/pcap] ${epochFallbackCount} packet(s) had an unparseable packetTime and were stamped at the epoch (sensor=${sensor}, requestTime=${requestTime})`,
        );
      }
      const filename = buildPcapFilename(sensor, requestTime);
      // Wrap the bytes in a Blob for a well-typed `BodyInit`. The
      // Uint8Array is a view over a freshly-allocated, exactly-sized
      // ArrayBuffer, so the Blob holds the precise capture bytes.
      return new Response(new Blob([file]), {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.tcpdump.pcap",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(file.byteLength),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof PcapCapExceededError) {
        return NextResponse.json(
          { error: "Capture too large", code: "pcap-cap-exceeded" },
          { status: 413 },
        );
      }
      if (err instanceof DetectionForbiddenError) {
        return NextResponse.json(
          { error: "Forbidden", code: "forbidden-customer-scope" },
          { status: 403 },
        );
      }
      if (
        err instanceof DetectionUnauthorizedError ||
        err instanceof ReviewForbiddenError
      ) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (err instanceof ReviewInvalidArgumentError) {
        return NextResponse.json(
          { error: "Invalid argument" },
          { status: 400 },
        );
      }
      if (err instanceof ExternalServiceUnavailableError) {
        return NextResponse.json(
          { error: "Data store unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: "Failed to assemble packet capture" },
        { status: 500 },
      );
    }
  },
  { requiredPermissions: ["detection:read"] },
);

/**
 * Build the download filename, e.g.
 * `detection-pcap_sensor-01-1a2b3c4d_2026-04-20T15-32-04.pcap`. The
 * sensor id and timestamp are reduced to the filename-safe alphabet
 * (alphanumerics, `.`, `_`, `-`) so neither can inject quotes, path
 * separators, or CR/LF into the Content-Disposition header.
 *
 * `sanitizeSegment` truncates the readable sensor prefix to 120 chars,
 * so two distinct long sensor ids sharing that prefix would otherwise
 * collide to one filename. A short hex suffix derived from the **full**
 * (untruncated) sensor id is appended to keep filenames collision-
 * resistant; the suffix is hex, so it too stays within the safe
 * alphabet. Exported so the collision behavior is unit-testable.
 */
export function buildPcapFilename(sensor: string, requestTime: string): string {
  const safeSensor = sanitizeSegment(sensor) || "sensor";
  const suffix = sensorHashSuffix(sensor);
  const safeTime = sanitizeSegment(requestTime.replace(/[:.]/g, "-"));
  return `detection-pcap_${safeSensor}-${suffix}_${safeTime}.pcap`;
}

/**
 * First 8 hex chars of the SHA-256 of the full sensor id. Computed
 * before truncation so two sensor ids that sanitize to the same 120-
 * char prefix still produce distinct filenames. Hex stays within the
 * `[A-Za-z0-9._-]` alphabet, preserving the header-injection guard.
 */
function sensorHashSuffix(sensor: string): string {
  return createHash("sha256").update(sensor, "utf8").digest("hex").slice(0, 8);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}
