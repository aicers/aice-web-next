import type { Event } from "@/lib/detection/types";
import { lookupMitreContext } from "@/lib/events/mitre-catalogue";

export interface ContextLabels {
  threatName: string;
  threatCategory: string;
  threatLevel: string;
  explanation: string;
  mitre: string;
  tactic: string;
  technique: string;
  subTechnique: string;
  none: string;
}

interface Props {
  event: Event;
  labels: ContextLabels;
}

export function ContextTab({ event, labels }: Props) {
  const attackKind = (event as Partial<{ attackKind: string }>).attackKind;
  const mitre = lookupMitreContext({
    __typename: event.__typename,
    attackKind,
    category: event.category ?? null,
  });

  return (
    <div className="flex flex-col gap-3">
      <section className="border-border bg-card flex flex-col gap-2 rounded-md border p-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{labels.threatName}</dt>
          <dd className="text-foreground">
            {attackKind && attackKind.length > 0 ? attackKind : labels.none}
          </dd>

          <dt className="text-muted-foreground">{labels.threatCategory}</dt>
          <dd className="text-foreground">{event.category ?? labels.none}</dd>

          <dt className="text-muted-foreground">{labels.threatLevel}</dt>
          <dd className="text-foreground">{event.level}</dd>
        </dl>
      </section>

      {mitre && (mitre.tacticId || mitre.techniqueId) ? (
        <section className="border-border bg-card flex flex-col gap-2 rounded-md border p-4">
          <h3 className="text-foreground text-sm font-semibold">
            {labels.mitre}
          </h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {mitre.tacticId ? (
              <>
                <dt className="text-muted-foreground">{labels.tactic}</dt>
                <dd className="text-foreground">
                  <MitreLink id={mitre.tacticId} name={mitre.tacticName} />
                </dd>
              </>
            ) : null}
            {mitre.techniqueId ? (
              <>
                <dt className="text-muted-foreground">{labels.technique}</dt>
                <dd className="text-foreground">
                  <MitreLink
                    id={mitre.techniqueId}
                    name={mitre.techniqueName}
                  />
                </dd>
              </>
            ) : null}
            {mitre.subTechniqueId ? (
              <>
                <dt className="text-muted-foreground">{labels.subTechnique}</dt>
                <dd className="text-foreground">
                  <MitreLink
                    id={mitre.subTechniqueId}
                    name={mitre.subTechniqueName}
                  />
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      {mitre?.explanation ? (
        <section className="border-border bg-card flex flex-col gap-2 rounded-md border p-4">
          <h3 className="text-foreground text-sm font-semibold">
            {labels.explanation}
          </h3>
          <p className="text-muted-foreground text-sm">{mitre.explanation}</p>
        </section>
      ) : null}
    </div>
  );
}

function MitreLink({ id, name }: { id: string; name: string | undefined }) {
  const url = mitreUrl(id);
  const display = name ? `${id} · ${name}` : id;
  if (!url) return <span>{display}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-foreground hover:underline"
    >
      {display}
    </a>
  );
}

function mitreUrl(id: string): string | null {
  if (id.startsWith("TA")) return `https://attack.mitre.org/tactics/${id}/`;
  if (id.startsWith("T")) {
    const [base, sub] = id.split(".");
    return sub
      ? `https://attack.mitre.org/techniques/${base}/${sub}/`
      : `https://attack.mitre.org/techniques/${base}/`;
  }
  return null;
}
