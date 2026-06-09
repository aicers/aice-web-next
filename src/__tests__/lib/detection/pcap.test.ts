import { describe, expect, it } from "vitest";

import {
  assemblePcapFile,
  estimateBase64Bytes,
  LINKTYPE_ETHERNET,
  PCAP_MAX_PACKETS,
  PCAP_SNAPLEN,
  PcapCapExceededError,
  rfc3339ToEpochMicros,
} from "@/lib/detection/pcap";

const GLOBAL_HEADER_BYTES = 24;
const RECORD_HEADER_BYTES = 16;

/** base64 of the 4 bytes DE AD BE EF. */
const FRAME_B64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64");

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("rfc3339ToEpochMicros", () => {
  it("splits seconds and microseconds from a fractional timestamp", () => {
    expect(rfc3339ToEpochMicros("1970-01-01T00:00:01.000002Z")).toEqual({
      seconds: 1,
      micros: 2,
    });
  });

  it("recovers sub-millisecond precision beyond Date.parse", () => {
    // .123456 -> 123456 µs (Date.parse alone would round to 123 ms).
    expect(rfc3339ToEpochMicros("2026-01-02T03:04:05.123456Z")).toMatchObject({
      micros: 123456,
    });
  });

  it("treats a timestamp with no fraction as whole seconds", () => {
    expect(rfc3339ToEpochMicros("2026-01-02T03:04:05Z").micros).toBe(0);
  });

  it("falls back to the epoch for an unparseable value", () => {
    expect(rfc3339ToEpochMicros("not-a-time")).toEqual({
      seconds: 0,
      micros: 0,
    });
  });
});

describe("assemblePcapFile", () => {
  it("writes a classic global header with the Ethernet link type", () => {
    const file = assemblePcapFile([
      { packetTime: "1970-01-01T00:00:01.000002Z", packet: FRAME_B64 },
    ]);
    const view = viewOf(file);
    expect(view.getUint32(0, true)).toBe(0xa1b2c3d4); // magic, µs resolution
    expect(view.getUint16(4, true)).toBe(2); // version major
    expect(view.getUint16(6, true)).toBe(4); // version minor
    expect(view.getUint32(16, true)).toBe(PCAP_SNAPLEN);
    expect(view.getUint32(20, true)).toBe(LINKTYPE_ETHERNET);
  });

  it("frames each packet with a record header and the raw bytes", () => {
    const file = assemblePcapFile([
      { packetTime: "1970-01-01T00:00:01.000002Z", packet: FRAME_B64 },
    ]);
    const view = viewOf(file);
    const rec = GLOBAL_HEADER_BYTES;
    expect(view.getUint32(rec, true)).toBe(1); // ts_sec
    expect(view.getUint32(rec + 4, true)).toBe(2); // ts_usec
    expect(view.getUint32(rec + 8, true)).toBe(4); // incl_len
    expect(view.getUint32(rec + 12, true)).toBe(4); // orig_len
    const payload = file.slice(
      rec + RECORD_HEADER_BYTES,
      rec + RECORD_HEADER_BYTES + 4,
    );
    expect(Array.from(payload)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("produces the exact byte length for multiple packets", () => {
    const file = assemblePcapFile([
      { packetTime: "1970-01-01T00:00:01Z", packet: FRAME_B64 },
      { packetTime: "1970-01-01T00:00:02Z", packet: FRAME_B64 },
    ]);
    // header + 2 * (record header + 4 payload bytes)
    expect(file.byteLength).toBe(
      GLOBAL_HEADER_BYTES + 2 * (RECORD_HEADER_BYTES + 4),
    );
  });

  it("returns a header-only file for an empty capture", () => {
    const file = assemblePcapFile([]);
    expect(file.byteLength).toBe(GLOBAL_HEADER_BYTES);
  });

  it("throws PcapCapExceededError above the packet-count cap", () => {
    // One past the cap. Construct lazily so the array is cheap.
    const packets = Array.from({ length: PCAP_MAX_PACKETS + 1 }, () => ({
      packetTime: "1970-01-01T00:00:01Z",
      packet: FRAME_B64,
    }));
    expect(() => assemblePcapFile(packets)).toThrow(PcapCapExceededError);
    try {
      assemblePcapFile(packets);
    } catch (err) {
      expect((err as PcapCapExceededError).kind).toBe("packets");
    }
  });
});

describe("estimateBase64Bytes", () => {
  it("estimates decoded size from base64 length", () => {
    // "3q2+7w==" decodes to 4 bytes; ceil(8 * 3 / 4) = 6 is a safe
    // upper bound for the running byte cap.
    expect(estimateBase64Bytes(FRAME_B64)).toBeGreaterThanOrEqual(4);
  });
});
