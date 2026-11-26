export type DomainErrorCode =
  | "not_found"
  | "invalid"
  | "conflict"
  | "forbidden"
  | "unauthorized"
  | "rate_limited"
  | "no_model"
  | "unavailable";

/** Errors the application raises on purpose; the HTTP layer maps `code` to a status. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found`);
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new DomainError("invalid", message, details);
