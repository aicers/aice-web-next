import { z } from "zod";

import {
  type NodeValidationMessages,
  nodeDescriptionSchema,
  nodeHostnameSchema,
  nodeNameSchema,
} from "./validation";

/**
 * Zod schema for the four user-provided node-metadata fields at the top
 * of the create/edit dialog. Mirrors `decisions/node-field-catalog.md`'s
 * "Node metadata" section. The dialog runs the cross-form check
 * (uniqueness against the visible list) outside this schema because the
 * list is not statically known.
 *
 * `messages` lets the dialog inject locale-aware error strings produced
 * by `useTranslations("nodes.dialog.validation")`. When omitted, the
 * primitive schema builders fall back to the English literals so other
 * call sites (tests, server-only code paths) do not have to thread a
 * locale through.
 */
export const buildNodeMetadataSchema = (messages?: NodeValidationMessages) =>
  z.object({
    name: nodeNameSchema(32, messages),
    customerId: z.string().min(1, messages?.required ?? "Required"),
    description: nodeDescriptionSchema(64, messages),
    hostname: nodeHostnameSchema(64, messages),
  });

/**
 * Default-locale schema kept as a const so existing tests and any
 * non-dialog consumers (e.g. server-side validation) can import it
 * without invoking the builder. The dialog uses `buildNodeMetadataSchema`
 * directly with translated messages.
 */
export const nodeMetadataSchema = buildNodeMetadataSchema();

export type NodeMetadataValues = z.infer<typeof nodeMetadataSchema>;
