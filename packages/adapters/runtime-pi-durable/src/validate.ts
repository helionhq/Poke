import type { MutableModels } from "@earendil-works/pi-ai/models";

export type KeyCheck = { ok: true } | { ok: false; error: string };

/**
 * Checks a Qwen Token Plan key with the smallest possible request (one output token on the
 * plan's fastest model) before Poke saves it. Keys start with `sk-sp-`.
 */
export async function validateQwenKey(
  models: MutableModels,
  providerId: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  if (!key.startsWith("sk-sp-")) return { ok: false, error: "Qwen Token Plan keys start with sk-sp-" };
  const available = models.getModels(providerId);
  const probe = available.find((m) => m.id === "qwen3.6-flash") ?? available[0];
  if (!probe) return { ok: false, error: `${providerId} has no models to check the key against` };
  const url = `${probe.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": "poke-server",
      },
      body: JSON.stringify({
        model: probe.id,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
        ...(probe.reasoning ? { enable_thinking: false } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't reach the Qwen Token Plan: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.ok || response.status === 429) return { ok: true };
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "The Qwen Token Plan rejected that key" };
  const detail = (await response.text().catch(() => "")).slice(0, 200);
  return {
    ok: false,
    error: `The Qwen Token Plan answered ${response.status}${detail ? `: ${detail}` : ""}`,
  };
}
