import "server-only";

/**
 * Server-side assembly of a classic libpcap (`.pcap`) file from the
 * raw packet bytes Giganto returns for a Detection event. The download
 * Route Handler decodes each base64 `Packet.packet` and frames it with
 * a global header + per-packet record headers so the result opens in
 * Wireshark. Raw bytes are handled only here and in the fetch helper —
 * they never pass through React state or a client action payload.
 *
 * ── Link-layer type (in-app-confirmed, real-capture pending) ────────
 *
 * The classic pcap global header carries a single datalink type for
 * the whole file, but `Packet` exposes no datalink field — only
 * `requestTime`, `packetTime`, and the raw `packet` bytes. Giganto
 * sensors (REconverge / piglet) capture at layer 2, so each stored
 * `packet` is a complete Ethernet frame, and Giganto's own
 * `pcap.parsedPcap` decodes those same bytes as Ethernet → IP →
 * transport. Because the parsed view and this download derive from the
 * **identical** `packet` bytes, the parsed dump rendering Ethernet/IP
 * layers is the in-app confirmation that the link-layer type is
 * {@link LINKTYPE_ETHERNET}. The value below is hardcoded per the
 * issue's pre-work gate rather than guessed per-request. The final
 * real-capture confirmation — that this constant and the timestamp
 * mapping below produce a Wireshark-usable `.pcap` for a real
 * detection — requires gauntlet stack access and is tracked in #729;
 * until it lands this assumption is in-app-confirmed but not yet
 * verified against real Giganto bytes.
 *
 * ── Timestamp mapping ───────────────────────────────────────────────
 *
 * The PacketFilter's `requestTime` is mapped from the Detection event's
 * `time` (see `fetchDetectionPackets`). Each pcap record header stamps
 * the on-wire capture time from `Packet.packetTime` (not the event /
 * request time), so frame timestamps in Wireshark reflect when the
 * packet was actually seen.
 */

/** libpcap datalink type for full Ethernet frames (DLT_EN10MB). */
export const LINKTYPE_ETHERNET = 1;

/**
 * Snapshot length advertised in the global header. Giganto stores full
 * frames, so this is the conventional 256 KiB ceiling rather than a
 * truncation point — `incl_len` equals `orig_len` for every record.
 */
export const PCAP_SNAPLEN = 262_144;

/** Classic pcap magic, microsecond timestamp resolution, written little-endian. */
const PCAP_MAGIC_USEC = 0xa1b2c3d4;
const PCAP_VERSION_MAJOR = 2;
const PCAP_VERSION_MINOR = 4;

const GLOBAL_HEADER_BYTES = 24;
const RECORD_HEADER_BYTES = 16;

const MICROS_PER_SECOND = 1_000_000;

/**
 * Hard cap on the number of packets assembled into a single `.pcap`.
 * Mirrors the CSV export route's row ceiling: a single download must
 * not stream an unbounded capture into memory. When a capture exceeds
 * the cap the request fails loudly (413) instead of silently
 * truncating the file.
 */
export const PCAP_MAX_PACKETS = 200_000;

/**
 * Hard cap on the total raw-byte volume assembled into a single
 * `.pcap`. Bounds peak memory / response time independently of the
 * packet count, since one capture can mix tiny and jumbo frames.
 */
export const PCAP_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Thrown when the packet count or byte volume crosses a hard cap
 * ({@link PCAP_MAX_PACKETS} / {@link PCAP_MAX_BYTES}). The download
 * route maps it to a 413 so the browser surfaces a failed download
 * rather than accepting a silently truncated capture.
 */
export class PcapCapExceededError extends Error {
  readonly kind: "packets" | "bytes";
  constructor(kind: "packets" | "bytes") {
    super(
      kind === "packets"
        ? `PCAP export exceeded the ${PCAP_MAX_PACKETS}-packet hard cap`
        : `PCAP export exceeded the ${PCAP_MAX_BYTES}-byte hard cap`,
    );
    this.name = "PcapCapExceededError";
    this.kind = kind;
  }
}

/** One Giganto packet record relevant to `.pcap` assembly. */
export interface PcapPacketInput {
  /** On-wire capture time (RFC 3339), stamped into the record header. */
  packetTime: string;
  /** Base64-encoded raw frame bytes. */
  packet: string;
}

/**
 * Split an RFC 3339 timestamp into whole epoch seconds plus the
 * microsecond remainder for a pcap record header. `Date.parse` only
 * yields millisecond precision, so the fractional-seconds group is read
 * straight from the string to recover sub-millisecond digits Giganto
 * may carry. Unparseable input maps to the epoch (0, 0) rather than
 * throwing — a single bad timestamp must not abort a whole download.
 */
export function rfc3339ToEpochMicros(value: string): {
  seconds: number;
  micros: number;
} {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { seconds: 0, micros: 0 };
  let seconds = Math.floor(ms / 1000);
  let micros = (ms - seconds * 1000) * 1000;
  const fraction = /[.,](\d+)/.exec(value);
  if (fraction) {
    // Pad/truncate the fractional digits to exactly 6 (microseconds).
    micros = Number.parseInt(fraction[1].slice(0, 6).padEnd(6, "0"), 10);
  }
  if (micros >= MICROS_PER_SECOND) {
    seconds += Math.floor(micros / MICROS_PER_SECOND);
    micros %= MICROS_PER_SECOND;
  }
  return { seconds, micros };
}

function writeGlobalHeader(view: DataView): void {
  view.setUint32(0, PCAP_MAGIC_USEC, true);
  view.setUint16(4, PCAP_VERSION_MAJOR, true);
  view.setUint16(6, PCAP_VERSION_MINOR, true);
  view.setInt32(8, 0, true); // thiszone (GMT to local correction)
  view.setUint32(12, 0, true); // sigfigs (timestamp accuracy)
  view.setUint32(16, PCAP_SNAPLEN, true); // snaplen
  view.setUint32(20, LINKTYPE_ETHERNET, true); // network (datalink type)
}

/**
 * Assemble a classic libpcap file from decoded packet records.
 *
 * Layout: a 24-byte global header followed, for each packet, by a
 * 16-byte record header (`ts_sec`, `ts_usec`, `incl_len`, `orig_len`)
 * and the raw frame bytes. All multi-byte integers are little-endian to
 * match {@link PCAP_MAGIC_USEC}.
 *
 * Cap enforcement is defensive-in-depth: the fetch helper already
 * bounds the connection, but a caller that hands in an oversized array
 * still trips {@link PcapCapExceededError} here rather than allocating
 * an unbounded buffer.
 */
export function assemblePcapFile(
  packets: readonly PcapPacketInput[],
): Uint8Array<ArrayBuffer> {
  if (packets.length > PCAP_MAX_PACKETS) {
    throw new PcapCapExceededError("packets");
  }

  const frames: Uint8Array[] = [];
  let payloadBytes = 0;
  for (const { packet } of packets) {
    const frame = decodeBase64(packet);
    payloadBytes += frame.length;
    if (payloadBytes > PCAP_MAX_BYTES) {
      throw new PcapCapExceededError("bytes");
    }
    frames.push(frame);
  }

  const total =
    GLOBAL_HEADER_BYTES + frames.length * RECORD_HEADER_BYTES + payloadBytes;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  writeGlobalHeader(view);

  let offset = GLOBAL_HEADER_BYTES;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const { seconds, micros } = rfc3339ToEpochMicros(packets[i].packetTime);
    view.setUint32(offset, seconds >>> 0, true); // ts_sec
    view.setUint32(offset + 4, micros >>> 0, true); // ts_usec
    view.setUint32(offset + 8, frame.length, true); // incl_len
    view.setUint32(offset + 12, frame.length, true); // orig_len
    offset += RECORD_HEADER_BYTES;
    out.set(frame, offset);
    offset += frame.length;
  }

  return out;
}

/**
 * Decode a base64 string to raw bytes. Uses `Buffer` (always present in
 * the Node.js server runtime where this module executes). Invalid
 * base64 decodes to whatever `Buffer` salvages rather than throwing, so
 * one malformed packet cannot abort a whole capture.
 */
function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Conservative byte estimate for a base64 string without decoding it —
 * used by the fetch helper's running byte cap so it can stop paging
 * before decoding. Every 4 base64 chars encode ≤ 3 bytes.
 */
export function estimateBase64Bytes(value: string): number {
  return Math.ceil((value.length * 3) / 4);
}
