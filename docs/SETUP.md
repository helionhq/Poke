# Setup

How to put Poke on its own machine, reach it from the iPhone, and keep it updated. For the app
side (SideStore, the source, refreshes), see [IOS.md](IOS.md).

## What you need

- A machine that belongs to Poke, running Ubuntu 24.04 or newer, with at least 4 GB of RAM and
  20 GB free. Poke runs as its main user and uses it fully.
- Docker Engine with the Compose plugin (`poke setup` offers to install it).
- Tailscale on the machine and on the laptop whose browser Poke may use.
- A Cloudflare account with the domain (`arham.im`) on it, for the tunnel.
- A GitHub fine-grained token, read-only (Contents: read) on the Poke repository, for installing
  and updating.
- Accounts and keys, added during setup or later: Claude subscription (`claude setup-token`), Qwen
  Token Plan, Voyage, AssemblyAI, Keenable, Executor, and the Bark app on the iPhone.

## 1. Install

Clone the private repository. Git asks for a username (anything) and a password (paste the GitHub
token); nothing is saved in the checkout.

```sh
git clone https://github.com/helionhq/Poke.git ~/Poke
cd ~/Poke
./install.sh
```

`install.sh` installs Node 24 and pnpm if they're missing, installs the dependencies, builds the
server and the CLI, links `poke` into `~/.local/bin`, and turns on lingering
(`loginctl enable-linger`) so Poke keeps running with nobody logged in. It asks for `sudo` only for
Node and lingering, and is safe to run again.

## 2. `poke setup`

An idempotent wizard. Every step after the preflight can be skipped; the summary at the end lists
what's left and the command for each. Run one step again with `poke setup --only <step>`.

| Step | What it does | Later |
|---|---|---|
| Preflight | Ubuntu, Docker and Compose, Node, disk and RAM, free ports, Tailscale. Offers fixes. | `poke setup --preflight` |
| Folders | `~/poke/{data,keys,workspace,library,skills,services,run,logs,updates}` and the master key (`~/poke/keys`, 0600). | |
| Profile | Name, timezone, home city. | `poke config profile.name …` |
| Logins | Claude (runs `claude setup-token`), Qwen, Qwen CN, Voyage. Each is checked before it's saved. | `poke login` |
| Keys | Executor, Keenable, AssemblyAI, GitHub, Bark, Cloudflare. Secrets are typed at a hidden prompt or piped with `--stdin`, never passed as arguments. | `poke config` |
| Models | Provider, model and reasoning level per role. | `poke model` |
| memory | Honcho at its pinned version, with Postgres and Redis, in Docker. Needs both memory models and Voyage. | `poke setup --only memory` |
| notifications | bark-server in Docker, the device key from the Bark app, a test push. | `poke setup --only notifications` |
| tunnel | The Cloudflare Tunnel token, cloudflared in Docker, a check from outside. | `poke setup --only tunnel` |
| service | Installs `poke.service` (systemd user unit) and the nightly update timer, then starts Poke. | `poke setup --only service` |
| pair | A QR code for the iPhone. | `poke config devices` |

### AssemblyAI (voice)

Dictation, read aloud and calls use AssemblyAI. Create a key in the AssemblyAI dashboard, then:

```sh
poke config assemblyai.key        # hidden prompt
```

Until a key is set, read aloud falls back to the iPhone's own voice, and dictation and calls say
they need setting up.

### GitHub token (updates)

`poke update` fetches with the same read-only token:

```sh
poke config github.token
```

It reaches git through git's environment for that one command, so it never appears in `ps`, the
shell history or `.git/config`.

## 3. Cloudflare Tunnel

The machine has no open ports. The tunnel is the only way in from the internet, and it serves two
hostnames:

| Hostname | Goes to | What |
|---|---|---|
| `poke.arham.im` | `http://localhost:7070` | Poke's API: the app, OTA updates, the SideStore source |
| `bark.arham.im` | `http://localhost:8090` | bark-server, which the Bark app registers with |

1. In the Cloudflare dashboard, go to **Networking > Tunnels** and **Create a tunnel** (type
   Cloudflared). Name it `poke`.
2. Copy the token: the long value after `--token` in the install command it shows. You don't need
   to run that command.
3. Run `poke setup --only tunnel` and paste the token. Poke saves it in the vault, writes
   `~/poke/services/cloudflared.env` (0600), and starts cloudflared in Docker.
4. Back in the dashboard, open the tunnel, then **Routes > Add route > Published application**,
   once for each row of the table above. The dashboard creates the DNS records.
5. The setup step checks `https://poke.arham.im/v1/health` from outside. If it answers, the phone
   can reach Poke.

cloudflared runs with host networking because Poke's API only listens on 127.0.0.1. Its token
reaches it through the env file, never its command line. `poke logs tunnel` shows its log, and
`curl http://127.0.0.1:20241/ready` answers 200 once it's connected.

Optional: put Cloudflare Access in front of `poke.arham.im` with a service token. The pairing QR
code then carries the service token headers, and the app sends them with every request, including
update checks. The `/sidestore/…` paths must stay outside Access (SideStore can't send headers):
add a bypass policy for `poke.arham.im/sidestore/*`.

## 4. Running

`poke.service` is a systemd user unit (`~/.config/systemd/user/poke.service`). It starts at boot,
restarts if the server stops, and logs to the journal and `~/poke/logs/poke.log`. The Docker
services have `restart: unless-stopped`.

| Command | |
|---|---|
| `poke status` | Services, tunnel, logins, models, context, usage, tasks, routines |
| `poke start` / `stop` / `restart [service]` | Everything, or one: `poke`, `honcho`, `memory`, `bark`, `tunnel`, or a Docker service name |
| `poke logs [service] [-f]` | The server's journal and the containers' logs |
| `poke update` | Update from GitHub (below) |

## 5. Updates

`poke update`:

1. Fetches from GitHub with the token and shows the new commits. If there are none, it stops.
2. Fast-forwards the checkout to `origin/main` (or `--ref <branch|tag|commit>`), remembering the
   previous commit.
3. Runs `pnpm install --frozen-lockfile` and builds. If the build fails, it goes back to the
   previous commit; the running server was never touched.
4. Hands over to the new build, which:
   - exports the app's JS update into `~/poke/updates/ota/<runtime>/` (the phone fetches it on its
     next launch or resume);
   - if the app's native code changed, downloads that commit's IPA from GitHub Releases into
     `~/poke/updates/ipa/` (SideStore then shows an Update button). If CI hasn't finished yet, it
     says so; run `poke update` again later;
   - stops Poke, backs up `poke.db` to `~/poke/data/backups/` (newest five kept), and runs the
     database migrations;
   - if `infra/compose` changed, re-renders the env files and recreates the running services that
     changed. A new Honcho version waits for `poke update --honcho`;
   - starts Poke and checks it answers.
5. If anything after the build fails, it rolls back: the previous commit, the database backup, the
   previous build, and removes the new app update.

Nightly updates: `poke config update.auto true`. The `poke-update.timer` runs `poke update` around
04:00; it does nothing while `update.auto` is off.

The checkout must have no local changes (`poke update` refuses otherwise).

## 6. Firewall

Nothing needs to be reachable from the LAN or the internet: the tunnel connects out, and the
laptop's browser relay goes over Tailscale. With ufw:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0              # SSH, the browse relay, everything over Tailscale
sudo ufw allow from 172.16.0.0/12 to any port 7071 proto tcp   # Honcho (Docker) to Poke's model gateway
sudo ufw enable
```

If you also need SSH from the LAN before Tailscale is up, add `sudo ufw allow OpenSSH` (and
remove it later). The Docker services publish their ports on 127.0.0.1 only, so Docker's own
firewall rules don't expose them.

## 7. Files

| Path | What |
|---|---|
| `~/Poke` | The checkout: code, builds, `infra/` |
| `~/poke/data/poke.db` | The thread, tasks, routines, settings |
| `~/poke/data/vault.db` | The vault (encrypted with the master key) |
| `~/poke/keys/master.key` | The master key (0600). Back it up somewhere safe: without it the vault can't be read |
| `~/poke/data/backups/` | `poke.db` copies made by `poke update` |
| `~/poke/services/` | Docker data and the rendered env files (0600) |
| `~/poke/updates/` | App updates and native builds the server hands out |
| `~/poke/logs/` | The server's log |
