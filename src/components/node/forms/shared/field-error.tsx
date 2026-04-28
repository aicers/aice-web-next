import { cn } from "@/lib/utils";

interface FieldErrorProps {
  id?: string;
  message: string | undefined;
  className?: string;
}

/**
 * Inline error renderer used by the per-service forms. Renders nothing
 * when there is no message so the caller can keep the layout stable.
 */
export function FieldError({ id, message, className }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className={cn("text-destructive text-sm", className)}
    >
      {message}
    </p>
  );
}
