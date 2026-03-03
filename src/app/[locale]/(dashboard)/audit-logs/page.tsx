import { Suspense } from "react";

import { AuditLogTable } from "@/components/audit/audit-log-table";

export default function AuditLogsPage() {
  return (
    <Suspense>
      <AuditLogTable />
    </Suspense>
  );
}
