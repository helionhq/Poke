/** Secrets shorter than this aren't redacted: they'd match ordinary text. */
const MIN_SECRET = 6;
/** What a secret is replaced with when its name can't be shown. */
export const REDACTED = "[vault:secret]";

/** A live secret and the vault name it is shown as: `[vault:resy.login]`. */
export interface LiveSecret {
  name: string;
  value: string;
}

/** The label a redacted secret leaves behind. Names are vault names, so the label is JSON-safe. */
export function redactionLabel(name: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(name) ? `[vault:${name}]` : REDACTED;
}

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
 * Scrubs live secrets from any text before it reaches a model, the transcript, a log or a UI, and
 * leaves `[vault:<name>]` in their place (section 10). Longest forms first, so a secret inside a
 * longer encoded form doesn't leave a partial match.
 */
export class SecretRedactor {
  #cacheKey = "";
  #forms: Array<{ form: string; label: string }> = [];

  constructor(private readonly secrets: () => readonly LiveSecret[]) {}

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const { form, label } of this.#currentForms()) {
      if (out.includes(form)) out = out.split(form).join(label);
    }
    return out;
  }

  redactValue<T>(value: T): T {
    if (value === undefined || value === null) return value;
    const raw = JSON.stringify(value);
    const redacted = this.redact(raw);
    return redacted === raw ? value : (JSON.parse(redacted) as T);
  }

  #currentForms(): Array<{ form: string; label: string }> {
    const secrets = this.secrets();
    const key = secrets.map((s) => `${s.name}\u0001${s.value}`).join("\u0000");
    if (key !== this.#cacheKey) {
      this.#cacheKey = key;
      const byForm = new Map<string, string>();
      for (const secret of secrets) {
        const label = redactionLabel(secret.name);
        for (const form of secretForms(secret.value)) if (!byForm.has(form)) byForm.set(form, label);
      }
      this.#forms = [...byForm]
        .map(([form, label]) => ({ form, label }))
        .sort((a, b) => b.form.length - a.form.length);
    }
    return this.#forms;
  }
}
