import { getTranslations } from "next-intl/server";

export default async function NodesForbidden() {
  const t = await getTranslations("nodes.forbidden");
  return (
    <div
      className="border-destructive/30 bg-destructive/5 rounded-lg border p-8"
      data-testid="nodes-forbidden"
    >
      <h2 className="text-destructive text-lg font-semibold">{t("title")}</h2>
      <p className="text-muted-foreground mt-2 text-sm">{t("description")}</p>
    </div>
  );
}
