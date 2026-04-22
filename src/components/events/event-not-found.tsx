import { ArrowLeft } from "lucide-react";

import { Link } from "@/i18n/navigation";

export interface EventNotFoundLabels {
  invalidTokenTitle: string;
  invalidTokenBody: string;
  notFoundTitle: string;
  notFoundBody: string;
  fetchErrorTitle: string;
  fetchErrorBody: string;
  back: string;
}

interface Props {
  reason: "invalid-token" | "not-found" | "fetch-error";
  backHref: string;
  labels: EventNotFoundLabels;
}

export function EventNotFound({ reason, backHref, labels }: Props) {
  const title =
    reason === "invalid-token"
      ? labels.invalidTokenTitle
      : reason === "fetch-error"
        ? labels.fetchErrorTitle
        : labels.notFoundTitle;
  const body =
    reason === "invalid-token"
      ? labels.invalidTokenBody
      : reason === "fetch-error"
        ? labels.fetchErrorBody
        : labels.notFoundBody;

  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-3 py-12">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Link
        href={backHref}
        className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {labels.back}
      </Link>
    </div>
  );
}
