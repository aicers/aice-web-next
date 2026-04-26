import { redirect } from "next/navigation";

import { NodeTabs } from "@/components/node/node-tabs";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentSession } from "@/lib/auth/session";

export default async function NodesLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/sign-in");
  }

  const [canReadNodes, canReadServices] = await Promise.all([
    hasPermission(session.roles, "nodes:read"),
    hasPermission(session.roles, "services:read"),
  ]);
  if (!canReadNodes || !canReadServices) {
    redirect("/");
  }

  return (
    <div className="space-y-6">
      <NodeTabs />
      {children}
    </div>
  );
}
