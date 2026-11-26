# Security

_The vault, redaction and approvals sections are filled in during milestone 5. See the brief,
sections 3.9, 10 and 12._

## Network surface

- poke-server listens on `127.0.0.1:7070` only. It is reachable from outside through the Cloudflare
  Tunnel (`poke.arham.im`), never on a LAN or public interface.
- The admin API is a unix socket (`~/poke/run/admin.sock`, mode 0600) and does not exist on the
  TCP listener. Anyone who can open it is Poke's own user, which already owns `~/poke`.

## Devices

- Pairing codes are single use, expire after 10 minutes and are stored as sha256 hashes. After ten
  wrong codes in ten minutes, pairing is locked for the rest of the window.
- Device tokens are 32 random bytes (`pk_…`), shown once, stored only as sha256 hashes and looked up
  by hash (the raw token is never stored). Revoking a device invalidates its token
  immediately.
- Share tokens (for the iOS "Share to Poke" Shortcut) can only call `POST /v1/share`.
- The WebSocket bearer subprotocol is never echoed back in the handshake response.
- API responses never include token hashes.

## Files

- Attachments are written under `~/poke/library/attachments/YYYY/MM/` with sanitized names; the file
  store refuses paths that escape its root.
- The vault master key is created by `poke setup` at `~/poke/keys/master.key` (mode 0600). Under
  systemd, `LoadCredential=` can supply it instead (`$CREDENTIALS_DIRECTORY/master.key`).

## Model credentials (milestone 3)

- Every provider credential (`poke login`) lives in the vault's system namespace (`~/poke/data/vault.db`,
  XChaCha20-Poly1305 under the master key), never in `poke.db`, config files, git or the
  environment. pi-ai gets keys per request from a read-only credential store; it is never allowed
  to read env vars.
- The CLI never takes a secret as a command-line argument (it would land in shell history and
  `ps`): it prompts with a hidden input, or reads `--stdin`. Each credential is validated before
  it is saved.
- **The Claude subscription serves only the Poke and Side chat roles.** The model registry refuses it
  for any other role, and the Claude runtime refuses to open any other session. Executors, memory and
  the model gateway can't reach it.
- Claude Code runs with an environment built from an allowlist (PATH, HOME, locale, temp dirs) plus
  `CLAUDE_CODE_OAUTH_TOKEN` and Poke's own `CLAUDE_CONFIG_DIR`. Anything starting with
  `ANTHROPIC_`, `CLAUDE_CODE_USE_`, `AWS_`, `GOOGLE_`, `AZURE_`, `OPENAI_`, `VOYAGE_`,
  `DASHSCOPE_` or `QWEN_` is never passed, so an `ANTHROPIC_API_KEY` can't switch it to API
  billing. `settingSources: []` keeps user and project settings, hooks and CLAUDE.md files out;
  `--bare` is never used.

## Redaction (milestone 3)

Every tool result of every agent passes through the gateway's redactor before a model, the
transcript, a log or a notification sees it. The redaction set is every vault secret (system
credentials and entry secret fields), refreshed when the vault changes. Each value is matched raw and
as base64, base64url, URL-encoded and JSON-escaped text, longest first. Compaction summaries are
redacted before they are stored.


## Blocks (milestone 4)

- A value typed into a `secret_request` goes from the app to `POST /v1/blocks/:id/actions` and
  straight into the vault. It is never stored in a block, a message, the event log or the action
  log (which keeps the result, never the payload), never logged (request bodies aren't), and never
  echoed: an invalid secret payload only says "That value can't be saved". The agent gets
  `{status: "saved", vaultName, placeholder}`. Once saved, the value joins the redaction set.
- One-time codes are saved as ephemeral vault entries that expire after 10 minutes.
- Authority is server-side. The app sends an action name and a payload; the server checks the kind,
  that a user may send that action (`expire`, `connected` and `failed` are server-only), the current
  state, and the payload schema. A card press can only name a button the stored card has, and only
  its own field keys are passed on.
- Cards are data, not code: a fixed set of primitives, https images only (to be loaded through the
  server by the image proxy that comes with the app in milestone 9, with private addresses refused),
  logos by app id or domain, links opened only on a tap, with limits on size and depth.
- Actions are idempotent per `clientActionId` and serialised per block, so a retried or doubled tap
  can't save, book or approve twice.
