"use client";

import { useRegisterBreadcrumbLabel } from "@/components/providers/breadcrumb-label-provider";

interface NodeBreadcrumbRegistrarProps {
  /**
   * The node's display name (`node.nameDraft ?? node.name`) — the same
   * value the detail page renders as its `h1` title.
   */
  displayName: string;
}

/**
 * Publishes the node's display name as the breadcrumb label for a node
 * detail page, keeping the breadcrumb consistent with the page header
 * instead of showing the raw opaque node id. Renders nothing.
 */
export function NodeBreadcrumbRegistrar({
  displayName,
}: NodeBreadcrumbRegistrarProps) {
  useRegisterBreadcrumbLabel(displayName);

  return null;
}
