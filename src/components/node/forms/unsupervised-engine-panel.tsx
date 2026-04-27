"use client";

import { useTranslations } from "next-intl";

/**
 * REconverge (Unsupervised Engine) — informational-only panel.
 *
 * The wire `draft` for this service is always the empty string when
 * the service is enabled. The catalog records this as a deliberate
 * design: the agent reads its config from a local TOML file on the
 * node and aice-web-next does not surface those fields.
 */
export interface UnsupervisedEnginePanelProps {
  // Accepted for API parity with the configuration forms in the
  // service registry; the panel has no inputs to disable.
  disabled?: boolean;
}

export function UnsupervisedEnginePanel(
  _props: UnsupervisedEnginePanelProps = {},
) {
  const t = useTranslations("nodes.forms.unsupervisedEngine");
  return (
    <section
      data-slot="unsupervised-engine-panel"
      aria-labelledby="unsupervised-engine-panel-title"
      className="rounded-md border p-4 text-sm"
    >
      <h3 id="unsupervised-engine-panel-title" className="font-medium">
        {t("title")}
      </h3>
      <p className="text-muted-foreground mt-2">{t("description")}</p>
    </section>
  );
}
