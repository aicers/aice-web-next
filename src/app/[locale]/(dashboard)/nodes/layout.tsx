import { NodeTabs } from "@/components/node/node-tabs";

// The `nodes:read + services:read` gate lives in the sibling
// `(gate)/layout.tsx` (a route group). That layout is a CHILD of this
// segment, so its `forbidden()` throw is caught by `nodes/forbidden.tsx`
// and renders the localised panel; it also sits ABOVE every loading.tsx
// in the tree, so the throw lands before any Suspense fallback streams
// and the response actually carries HTTP 403.
//
// Doing the check here in `nodes/layout.tsx` instead would escape past
// `nodes/forbidden.tsx` (Next.js scopes forbidden.tsx to its segment's
// children, not the segment's own layout) and surface the framework's
// default 403 panel.
export default function NodesLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="space-y-6">
      <NodeTabs />
      {children}
    </div>
  );
}
