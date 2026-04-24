import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type SaveTarget,
  startSavePicker,
  streamResponseToHandle,
  triggerBlobDownload,
} from "@/components/detection/csv-download";

type FakeWritableOp = { kind: "write"; bytes: number } | { kind: "close" };

function makeFakeWritable(trace: FakeWritableOp[]): WritableStream<Uint8Array> {
  // Mimic the WritableStream contract of FileSystemWritableFileStream.
  // We only care that pipeTo pushes chunks through it in order and
  // that the stream is closed at the end — that is what the Round 6
  // "stream directly to disk" concern is about.
  return new WritableStream<Uint8Array>({
    write(chunk) {
      trace.push({ kind: "write", bytes: chunk.byteLength });
    },
    close() {
      trace.push({ kind: "close" });
    },
  });
}

function makeStreamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe("startSavePicker", () => {
  it("invokes showSaveFilePicker synchronously so transient activation is still alive", () => {
    // Reviewer Round 7: if the picker runs only after awaiting the
    // preflight fetch, the browser has already dropped activation
    // and throws SecurityError instead of opening the save dialog.
    // The contract is therefore that the picker is called on the
    // synchronous tail of the click handler — by the time
    // `startSavePicker` returns, `showSaveFilePicker` must already
    // have been invoked exactly once with the CSV accept types.
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn(),
    });

    const promise = startSavePicker("detection-events.csv", {
      showSaveFilePicker: picker,
    });

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker).toHaveBeenCalledWith({
      suggestedName: "detection-events.csv",
      types: [
        {
          description: "CSV",
          accept: { "text/csv": [".csv"] },
        },
      ],
    });
    // The returned promise still flows through normally.
    return expect(promise).resolves.toMatchObject({ kind: "handle" });
  });

  it("resolves to cancelled when the operator dismisses the picker", async () => {
    const picker = vi
      .fn()
      .mockRejectedValue(new DOMException("dismissed", "AbortError"));

    const result = await startSavePicker("x.csv", {
      showSaveFilePicker: picker,
    });

    expect(result).toEqual({ kind: "cancelled" });
  });

  it("resolves to unsupported when the browser has no picker API", async () => {
    const result = await startSavePicker("x.csv", {
      showSaveFilePicker: null,
    });

    expect(result).toEqual({ kind: "unsupported" });
  });

  it("rejects non-Abort picker errors so the caller surfaces the failure", async () => {
    const picker = vi
      .fn()
      .mockRejectedValue(new Error("file system unwritable"));

    await expect(
      startSavePicker("x.csv", { showSaveFilePicker: picker }),
    ).rejects.toThrow(/file system unwritable/);
  });
});

describe("streamResponseToHandle", () => {
  it("pipes the response body straight into the picker-provided writable", async () => {
    // This exercises the exact "hand the response off to the
    // browser in a way that can stream directly to disk" contract:
    // the response body must flow through pipeTo into the
    // handle-owned WritableStream, not be materialized as a Blob
    // first. If a future regression reintroduces `response.blob()`
    // on this path, the trace loses its `write` entries and the
    // test fails.
    const writes: FakeWritableOp[] = [];
    const response = makeStreamingResponse(
      [new Uint8Array([65, 66, 67]), new Uint8Array([68, 69])],
      { "X-Total-Count": "2" },
    );
    const writable = makeFakeWritable(writes);
    const createWritable = vi.fn().mockResolvedValue(writable);
    const target: SaveTarget = {
      kind: "handle",
      handle: { createWritable } as {
        createWritable: () => Promise<WritableStream<Uint8Array>>;
      },
    };

    await streamResponseToHandle(response, target);

    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      { kind: "write", bytes: 3 },
      { kind: "write", bytes: 2 },
      { kind: "close" },
    ]);
  });

  it("throws when the response is missing a body so the caller can surface the failure", async () => {
    const response = new Response(null, { status: 200 });
    const target: SaveTarget = {
      kind: "handle",
      handle: { createWritable: vi.fn() },
    };

    await expect(streamResponseToHandle(response, target)).rejects.toThrow(
      /response body was missing/,
    );
  });
});

describe("triggerBlobDownload", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    // vitest's default environment does not implement the Blob URL
    // helpers; stub them so the fallback branch stays self-contained.
    URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it("materializes a Blob URL and clicks a hidden anchor with the disposition filename", async () => {
    const response = makeStreamingResponse([new Uint8Array([1, 2, 3])], {
      "Content-Disposition": 'attachment; filename="x.csv"',
    });
    const appendChild = vi.fn();
    const fakeAnchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(fakeAnchor),
      body: { appendChild },
    });

    await triggerBlobDownload(response, "fallback.csv");

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(fakeAnchor.download).toBe("x.csv");
    expect(fakeAnchor.click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("falls back to the caller-provided filename when Content-Disposition is absent", async () => {
    const response = makeStreamingResponse([new Uint8Array([1])], {});
    const appendChild = vi.fn();
    const fakeAnchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(fakeAnchor),
      body: { appendChild },
    });

    await triggerBlobDownload(response, "detection-events.csv");

    expect(fakeAnchor.download).toBe("detection-events.csv");
  });
});
