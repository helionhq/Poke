# Executor protocol notes (verified for milestone 6)

Read on 2026-11-26 from executor.sh/docs and the source of `UsefulSoftwareCo/executor` (branch `v2`,
`packages/mcp/src/contracts/*`, `packages/sdk/src/contracts/*`). Re-check against the live server
(`listTools`) before relying on field names.

## Endpoint
- Streamable HTTP MCP. With a personal access token: `<origin>/org/<org>/mcp`, header
  `Authorization: Bearer <PAT>`. Hosted origin assumed `https://mcp.executor.sh` (unconfirmed).
- `?elicitation_mode=` is `automatic` (default: approves everything), `model`, `native` or `browser`.
  Poke always uses `model`. A PAT takes its mode from the URL on every request.
- `GET /mcp/whoami` shows what a token reaches. 401 = revoked, 403 = lost membership.

## Meta-tools (inputs)
- `skills {app?, name?, file?, version?, revision?}`
- `search {query?, namespace?, limit?, offset?}` → `items, namespaces, remaining, next, unavailableApps`
- `describe {paths: string[1..20]}` → `items, namespaces, missing`
- `call {calls: {path, input} | {path, input}[]}` → per call `{ok: true, value} | {ok: false, error}`
- `execute {code: string ≤ 65536}` (5 min, 100 tool calls; approval waits don't count)
- `resume {requestId, response}`: `response` is an MCP elicit result,
  `{action: "accept", content: {}}` or `{action: "decline"}` (`cancel` advertised, unconfirmed).
  Approvals accept only empty `content`.

## Results
`call`, `execute` and `resume` return `content: [{type:"text", text: JSON}]` plus
`structuredContent` (never `isError`), one of:
- `{status: "completed", execution, unavailableApps}`
- `{status: "approval-required", requestId: "apr_…", invocation, elicitation, expiresAt}`:
  `invocation = {app, owner, version, tool, kind?: "query"|"mutation", input, accounts}`,
  `elicitation.message = "Approve <tool>?\n\nArguments: …"`. Expires after 15 minutes.
- `{status: "input-required", requestId: "elc_…", tool: {app, tool}, elicitation (form), expiresAt}`
- `{status: "unavailable", requestId, reason: answered|expired|ended|lost|malformed|not-found, message}`
- `busy`, `capacity-exceeded`.
- A paused call can't be resumed after Executor restarts; never re-run the program.

## Accounts
- Connection state: `state.status` ∈ `pending | expired | cancelled | completed` (lowercase;
  `completed` carries `account`). Pending requests expire after 30 minutes.
- `appAccounts.userConnect` response field for the connect link: **not found** in source or docs.
  Read it from a live call before building the connect flow.

## Catalog
- `https://catalog.executor.sh/index.json`: `{version: 1, apps: [{id, package, name, description,
  auth: [{method, kind: "secrets"|"oauth2", label?}], category?, icons: [{src, mimeType?, theme?}],
  source}]}`. Icon paths are relative to the feed.

## Gating
- Imported MCP tools are gated by `destructiveHint === true`; OpenAPI/GraphQL mutations are gated.
  Poke follows Executor's decision and adds no gating of its own.
