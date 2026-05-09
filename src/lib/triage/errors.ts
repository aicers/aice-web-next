/**
 * Typed errors raised by the Triage server actions. Mirror the
 * Detection family so the route layer can branch on the same shape.
 */

export class TriageUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageUnauthorizedError";
  }
}

export class TriageForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageForbiddenError";
  }
}
