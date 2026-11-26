/** Secrets shorter than this aren't redacted: they'd match ordinary text. */
const MIN_SECRET = 6;
export const REDACTED = "[redacted]";

/** Every form a secret commonly takes in tool output: raw, base64, URL- and JSON-encoded. */
export function secretForms(secret: string): string[] {
  if (secret.length < MIN_SECRET) return [];
  const forms = new Set<string>([secret]);
  const base64 = Buffer.from(secret, "utf8").toString("base64");
  forms.add(base64);
  forms.add(base64.replace(/=+$/, ""));
  forms.add(Buffer.from(secret, "utf8").toString("base64url"));
  forms.add(encodeURIComponent(secret));
  forms.add(JSON.stringify(secret).slice(1, -1));
  return [...forms].filter((form) => form.length >= MIN_SECRET);
}

/**
 * Scrubs live secrets from any text before it reaches a model, the transcript, a log or a UI.
 * Longest forms first, so a secret inside a longer encoded form doesn't leave a partial match.
 */
export class SecretRedactor {
  #cacheKey = "";
  #forms: string[] = [];

  constructor(private readonly secrets: () => readonly string[]) {}

  redact(text: string): string {
    if (!text) return text;
    const forms = this.#currentForms();
    let out = text;
    for (const form of forms) {
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
    return out;
  }

  redactValue<T>(value: T): T {
    if (value === undefined || value === null) return value;
    const raw = JSON.stringify(value);
    const redacted = this.redact(raw);
    return redacted === raw ? value : (JSON.parse(redacted) as T);
  }

  #currentForms(): string[] {
    const secrets = this.secrets();
    const key = secrets.join("\u0000");
    if (key !== this.#cacheKey) {
      this.#cacheKey = key;
      this.#forms = [...new Set(secrets.flatMap(secretForms))].sort((a, b) => b.length - a.length);
    }
    return this.#forms;
  }
}
