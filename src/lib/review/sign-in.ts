import { gql } from "graphql-request";
import { createReviewClient } from "./client";

export const SIGN_IN_MUTATION = gql`
  mutation SignIn($username: String!, $password: String!) {
    signIn(username: $username, password: $password) {
      token
      expirationTime
    }
  }
`;

export type SignInInput = {
  username: string;
  password: string;
};

export type SignInResult = {
  token: string;
  expirationTime: string;
};

export async function signIn({
  username,
  password,
}: SignInInput): Promise<SignInResult> {
  if (typeof window !== "undefined") {
    const response = await fetch("/api/review/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      let message: string;

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        try {
          const data = await response.json();
          message = JSON.stringify(data, null, 2);
        } catch {
          message = await response.text();
        }
      } else {
        message = await response.text();
      }

      throw new Error(
        `signIn request failed: ${response.status} ${response.statusText} - ${message}`,
      );
    }

    return (await response.json()) as SignInResult;
  }

  const client = createReviewClient();
  const result = await client.request<{ signIn: SignInResult }>(
    SIGN_IN_MUTATION,
    { username, password },
  );

  return result.signIn;
}
