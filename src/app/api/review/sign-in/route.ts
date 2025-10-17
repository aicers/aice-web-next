import { ClientError, GraphQLClient } from "graphql-request";
import { NextResponse } from "next/server";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createDispatcher } from "@/lib/review/request";
import {
  SIGN_IN_MUTATION,
  type SignInInput,
  type SignInResult,
} from "@/lib/review/sign-in";

const ENV_ENDPOINT =
  process.env.REVIEW_GRAPHQL_ENDPOINT ??
  process.env.NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT ??
  "";

function ensureEndpoint() {
  if (!ENV_ENDPOINT) {
    throw new Error(
      "REVIEW_GRAPHQL_ENDPOINT (or NEXT_PUBLIC_REVIEW_GRAPHQL_ENDPOINT) must be defined.",
    );
  }

  return ENV_ENDPOINT;
}

async function requestSignIn(credentials: SignInInput) {
  const endpoint = ensureEndpoint();
  const dispatcher = createDispatcher({
    allowSelfSigned: process.env.REVIEW_ALLOW_SELF_SIGNED === "true",
    caFilePath: process.env.REVIEW_CA_CERT_PATH,
    servername: process.env.REVIEW_TLS_SERVERNAME,
  });

  const client = new GraphQLClient(endpoint, {
    headers: {
      "content-type": "application/json",
    },
  });

  let restoreDispatcher: (() => void) | undefined;

  if (dispatcher) {
    const previousDispatcher = getGlobalDispatcher();
    setGlobalDispatcher(dispatcher);
    restoreDispatcher = () => setGlobalDispatcher(previousDispatcher);
  }

  try {
    const response = await client.request<{ signIn: SignInResult }>(
      SIGN_IN_MUTATION,
      credentials,
    );

    return response.signIn;
  } finally {
    restoreDispatcher?.();
  }
}

const shouldMockSignIn =
  process.env.MOCK_REVIEW_SIGN_IN === "true" ||
  process.env.NEXT_PUBLIC_MOCK_REVIEW_SIGN_IN === "true";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as SignInInput;

    if (!body?.username || !body?.password) {
      return NextResponse.json(
        { error: "username and password are required" },
        { status: 400 },
      );
    }

    if (shouldMockSignIn) {
      return NextResponse.json({
        token: `token-${body.username}`,
        expirationTime: "2030-01-01T00:00:00.000Z",
      } satisfies SignInResult);
    }

    const result = await requestSignIn(body);

    return NextResponse.json(result);
  } catch (error) {
    console.error("REview sign-in failed", error);

    if (error instanceof ClientError) {
      const statusFromResponse =
        typeof error.response.status === "number" ? error.response.status : 502;

      const status =
        statusFromResponse >= 200 && statusFromResponse < 300
          ? 502
          : statusFromResponse;

      let headers: Record<string, string> | undefined;

      try {
        const rawHeaders = error.response.headers;

        if (
          rawHeaders &&
          typeof (rawHeaders as unknown as { entries?: unknown }).entries ===
            "function"
        ) {
          headers = Object.fromEntries(
            (
              rawHeaders as { entries: () => Iterable<[string, string]> }
            ).entries(),
          );
        }
      } catch {
        headers = undefined;
      }

      return NextResponse.json(
        {
          error: {
            message: error.message,
            request: error.request,
            response: {
              status: statusFromResponse,
              headers,
              errors: error.response.errors,
              data: error.response.data,
            },
          },
        },
        { status },
      );
    }

    if (error instanceof Error) {
      return NextResponse.json(
        {
          error: {
            message: error.message,
          },
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ error }, { status: 502 });
  }
}
