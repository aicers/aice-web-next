import fs from "node:fs";
import { Agent } from "undici";

type CreateDispatcherOptions = {
  allowSelfSigned?: boolean;
  caFilePath?: string;
  servername?: string;
};

export function createDispatcher(options: CreateDispatcherOptions = {}) {
  const connectOptions: Record<string, unknown> = {};

  if (options.allowSelfSigned) {
    connectOptions.rejectUnauthorized = false;
  }

  if (options.caFilePath) {
    try {
      const ca = fs.readFileSync(options.caFilePath, "utf8");
      connectOptions.ca = ca;
    } catch (error) {
      console.warn(
        `Failed to read REVIEW_CA_CERT_PATH at ${options.caFilePath}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (Object.keys(connectOptions).length === 0) {
    return undefined;
  }

  if (options.servername) {
    connectOptions.servername = options.servername;
  }

  return new Agent({
    connect: connectOptions as NonNullable<
      ConstructorParameters<typeof Agent>[0]
    >["connect"],
  });
}
