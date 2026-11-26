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
