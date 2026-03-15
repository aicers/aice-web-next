import { SignInForm } from "@/components/auth/sign-in-form";
import {
  type SignInReason,
  SignInReasonScreen,
} from "@/components/auth/sign-in-reason-screen";

const VALID_REASONS = new Set<SignInReason>(["signed-out", "session-ended"]);

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = typeof params.reason === "string" ? params.reason : undefined;
  const reason =
    raw && VALID_REASONS.has(raw as SignInReason)
      ? (raw as SignInReason)
      : undefined;

  if (reason) {
    return <SignInReasonScreen reason={reason} />;
  }

  return <SignInForm />;
}
