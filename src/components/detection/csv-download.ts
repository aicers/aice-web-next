/**
 * Transport primitives for the CSV export download — kept in their
 * own module so tests can exercise the streaming behaviour without
 * dragging `useCsvExport`'s session / next-intl dependencies into
 * the vitest environment.
 *
 * The preferred path on Chromium is the File System Access API:
 * `showSaveFilePicker()` returns a file handle whose writable
 * stream satisfies `WritableStream<Uint8Array>`, so the server
 * response body can flow straight through `pipeTo(...)` without
 * ever being materialized as a `Blob`. Firefox and Safari still
 * lack the API as of 2026-04, so those browsers fall back to the
 * Blob anchor path; peak client memory on the fallback is bounded
 * by the server's hard per-export row cap (`CSV_EXPORT_MAX_ROWS`).
 *
 * `showSaveFilePicker()` consumes transient user activation at the
 * moment it is invoked. Chromium treats awaiting the preflight
 * `fetch()` as a boundary that drops activation, so if the picker
 * is opened after the fetch resolves it fails with `SecurityError`
 * and the operator never sees the save dialog (Reviewer Round 7).
 * `startSavePicker()` must therefore run **synchronously** inside
 * the click handler — it returns a promise the caller can await in
 * parallel with the preflight without losing activation.
 */

interface FileSystemWritableFileStreamLike extends WritableStream<Uint8Array> {}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
}

type ShowSaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept?: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandleLike>;

/**
 * Test seam — production code reads the picker off `window` at call
 * time, but tests can inject a fake picker (or force `null` for the
 * fallback path) without having to mutate the global.
 */
export interface DownloadHostOverrides {
  showSaveFilePicker?: ShowSaveFilePicker | null;
}

/**
 * Result of resolving the save picker. `handle` is the normal
 * success case; `cancelled` means the operator dismissed the save
 * dialog; `unsupported` means the browser has no File System Access
 * API and the caller should fall back to the Blob anchor path.
 */
export type SaveTarget =
  | { kind: "handle"; handle: FileSystemFileHandleLike }
  | { kind: "cancelled" }
  | { kind: "unsupported" };

function resolvePicker(
  overrides?: DownloadHostOverrides,
): ShowSaveFilePicker | null | undefined {
  if (overrides && Object.hasOwn(overrides, "showSaveFilePicker")) {
    return overrides.showSaveFilePicker;
  }
  return (
    globalThis as typeof globalThis & {
      showSaveFilePicker?: ShowSaveFilePicker;
    }
  ).showSaveFilePicker;
}

/**
 * Invoke `showSaveFilePicker()` synchronously within a user gesture
 * and return a promise that resolves to a {@link SaveTarget}. Must
 * be called as the first async step of the click handler — any
 * preceding `await` consumes transient activation and would cause
 * the picker to throw `SecurityError` instead of opening the save
 * dialog (Reviewer Round 7). The returned promise never rejects:
 * AbortError becomes `cancelled`, browsers without the API resolve
 * to `unsupported`, and other picker errors still surface as
 * rejections so callers can map them to a generic export failure.
 */
export function startSavePicker(
  suggestedName: string,
  overrides?: DownloadHostOverrides,
): Promise<SaveTarget> {
  const picker = resolvePicker(overrides);
  if (typeof picker !== "function") {
    return Promise.resolve({ kind: "unsupported" });
  }
  // CRITICAL: `picker(...)` must run before any `await` elsewhere
  // in the click-handler call stack. Invoking it here keeps the
  // transient activation alive at the moment the browser checks.
  const pickerCall = picker({
    suggestedName,
    types: [
      {
        description: "CSV",
        accept: { "text/csv": [".csv"] },
      },
    ],
  });
  return pickerCall.then<SaveTarget, SaveTarget>(
    (handle) => ({ kind: "handle", handle }),
    (err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { kind: "cancelled" };
      }
      throw err;
    },
  );
}

function extractFilename(response: Response): string | null {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? null;
}

/**
 * Stream a successful CSV response body straight into the save
 * handle the operator already chose. The response body flows
 * chunk-by-chunk through `pipeTo` into the File System Access
 * writable stream without ever being materialized as a Blob.
 */
export async function streamResponseToHandle(
  response: Response,
  handle: SaveTarget & { kind: "handle" },
): Promise<void> {
  if (!response.body) {
    throw new Error("Streaming download: response body was missing");
  }
  const writable = await handle.handle.createWritable();
  await response.body.pipeTo(writable);
}

/**
 * Legacy Blob-anchor download path. Used on browsers without the
 * File System Access API and only for the success response body —
 * peak client memory is bounded by the server's per-export row cap.
 */
export async function triggerBlobDownload(
  response: Response,
  fallbackFilename: string,
): Promise<void> {
  const filename = extractFilename(response) ?? fallbackFilename;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
