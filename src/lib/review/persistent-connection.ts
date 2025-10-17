type PersistentConnectionOptions = {
  token?: string | null;
  url?: string;
  onMessage?: (event: MessageEvent<string>) => void;
  onError?: (error: Event) => void;
};

const defaultStreamEndpoint =
  process.env.NEXT_PUBLIC_REVIEW_STREAM_ENDPOINT ?? "";

export function createPersistentConnection({
  token,
  url = defaultStreamEndpoint,
  onMessage,
  onError,
}: PersistentConnectionOptions = {}) {
  if (typeof window === "undefined") {
    throw new Error(
      "createPersistentConnection can only be used in the browser.",
    );
  }

  if (!url) {
    throw new Error(
      "A streaming endpoint must be provided via options.url or NEXT_PUBLIC_REVIEW_STREAM_ENDPOINT.",
    );
  }

  const streamUrl =
    token != null && token.length > 0 ? `${url}?token=${token}` : url;
  const eventSource = new EventSource(streamUrl);

  if (onMessage) {
    eventSource.onmessage = onMessage;
  }

  if (onError) {
    eventSource.onerror = onError;
  }

  return () => {
    eventSource.close();
  };
}
