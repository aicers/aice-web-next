import { Suspense } from "react";

import { PreferencesForm } from "@/components/profile/preferences-form";

export default function ProfilePage() {
  return (
    <Suspense>
      <PreferencesForm />
    </Suspense>
  );
}
