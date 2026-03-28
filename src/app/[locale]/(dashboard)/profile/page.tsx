import { Suspense } from "react";

import { PreferencesForm } from "@/components/profile/preferences-form";
import { TotpCard } from "@/components/profile/totp-card";

export default function ProfilePage() {
  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Suspense>
        <PreferencesForm />
      </Suspense>
      <Suspense>
        <TotpCard />
      </Suspense>
    </div>
  );
}
