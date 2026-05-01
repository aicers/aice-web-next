export const APP_URL =
  process.env.BASE_URL ?? `http://localhost:${process.env.APP_PORT ?? "3000"}`;

const originUrl = new URL(APP_URL);
if (originUrl.hostname === "127.0.0.1") {
  originUrl.hostname = "localhost";
}

export const APP_ORIGIN = originUrl.origin;
