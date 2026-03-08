import { Suspense } from "react";

import { AccountTable } from "@/components/accounts/account-table";

export default function AccountsPage() {
  return (
    <Suspense>
      <AccountTable />
    </Suspense>
  );
}
