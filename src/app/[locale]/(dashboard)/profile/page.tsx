import { Suspense } from "react";

import { PreferencesForm } from "@/components/profile/preferences-form";
import { TotpCard } from "@/components/profile/totp-card";
import { WebAuthnCard } from "@/components/profile/webauthn-card";

export default function ProfilePage() {
  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Suspense>
        <PreferencesForm />
      </Suspense>
      <Suspense>
        <TotpCard />
      </Suspense>
      <Suspense>
        <WebAuthnCard />
      </Suspense>
    </div>
  );
}
