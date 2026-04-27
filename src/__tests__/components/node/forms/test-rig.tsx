/**
 * Standalone local test harness for the per-service form components.
 *
 * Per the issue's acceptance bar ("React Testing Library + Vitest"),
 * the form suites mount real components with real `react-hook-form`
 * state under jsdom rather than swapping `Controller` / RHF for SSR
 * stand-ins. That lets the tests exercise actual `Controller` wiring,
 * RHF dirty / reset semantics, the `<details>` open-state path, and
 * the Enter / blur commit flow in `PortChipInput` — surfaces the
 * earlier `renderToStaticMarkup` rig could not cover.
 *
 * jsdom is scoped to this directory via `vitest.config.ts`'s `projects`
 * list; the rest of the suite keeps the existing `renderToStaticMarkup`
 * baseline, since broader adoption is a separate cross-repo decision.
 */

import { type RenderResult, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, useEffect } from "react";
import {
  type DefaultValues,
  type FieldValues,
  FormProvider,
  type UseFormReturn,
  useForm,
} from "react-hook-form";

import enMessages from "@/i18n/messages/en.json";

// `UseFormReturn`'s third generic is internal; keep the harness loose
// so callers can pass any `TValues` shape without repeating that
// constraint.
type AnyMethods<TValues extends FieldValues> = UseFormReturn<
  TValues,
  unknown,
  TValues
>;

interface FormHarnessProps<TValues extends FieldValues> {
  defaultValues: DefaultValues<TValues>;
  errors?: Record<string, string>;
  onReady?: (methods: AnyMethods<TValues>) => void;
  children: ReactNode;
}

function FormHarness<TValues extends FieldValues>({
  defaultValues,
  errors,
  onReady,
  children,
}: FormHarnessProps<TValues>) {
  const methods = useForm<TValues>({ defaultValues, mode: "onBlur" });
  // Inject any caller-supplied field errors via RHF's own `setError`
  // so the form components see real `formState.errors` entries — the
  // same shape Zod/`@hookform/resolvers` would feed them in production.
  useEffect(() => {
    if (!errors) return;
    for (const [name, message] of Object.entries(errors)) {
      if (typeof message === "string") {
        // RHF's `setError` accepts dotted-path string names; the
        // `Path<TValues>` constraint would force every caller to type
        // the path tuples by hand, which adds no test value.
        methods.setError(name as never, { type: "manual", message });
      }
    }
  }, [errors, methods]);
  useEffect(() => {
    onReady?.(methods as AnyMethods<TValues>);
  }, [methods, onReady]);
  return <FormProvider {...methods}>{children}</FormProvider>;
}

export interface RenderFormOptions<TValues extends FieldValues> {
  defaultValues: DefaultValues<TValues>;
  errors?: Record<string, string>;
  onReady?: (methods: AnyMethods<TValues>) => void;
}

/**
 * Render a form component under a real RHF `FormProvider` and the
 * project's `next-intl` provider seeded with the English message
 * bundle.
 */
export function renderForm<TValues extends FieldValues>(
  ui: ReactNode,
  options: RenderFormOptions<TValues>,
): RenderResult {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FormHarness<TValues>
        defaultValues={options.defaultValues}
        errors={options.errors}
        onReady={options.onReady}
      >
        {ui}
      </FormHarness>
    </NextIntlClientProvider>,
  );
}
