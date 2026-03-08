import { Suspense } from "react";

import { CustomerTable } from "@/components/customers/customer-table";

export default function CustomersPage() {
  return (
    <Suspense>
      <CustomerTable />
    </Suspense>
  );
}
