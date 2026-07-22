function asUtcDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

/** A presentation-only formatter. Persistence and API contracts remain UTC. */
export function formatLisbonDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Lisbon",
  }).format(asUtcDate(value));
}

export const lisbonTimeZoneLabel = "Europe/Lisbon";
