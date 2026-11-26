/** A short window around the first «match», so the hit reads in two lines. */
export function snippet(marked: string, width = 140): string {
  const at = marked.indexOf("«");
  if (at < 0 || marked.length <= width) return marked;
  const start = Math.max(0, at - 40);
  const end = Math.min(marked.length, start + width);
  return `${start > 0 ? "…" : ""}${marked.slice(start, end).trim()}${end < marked.length ? "…" : ""}`;
}

/** A server id from its URL: "https://mcp.linear.app/sse" → "mcp-linear-app". */
export function serverId(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the raw text
  }
  return (
    host
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "server"
  );
}
