#!/usr/bin/env bash
# Installs Poke on its machine (brief section 21): Node and pnpm if needed, the dependencies, a
# build, and the `poke` command. Run it from the checkout, as the machine's main user:
#
#   git clone https://github.com/<owner>/<repo>.git ~/Poke && cd ~/Poke && ./install.sh
#
# Safe to run again. It asks for sudo only to install Node and to let Poke run without anyone
# logged in (loginctl enable-linger).
set -euo pipefail

NODE_MAJOR=24
PNPM_VERSION=10.30.3
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the machine's main user, not root. Poke runs as that user." >&2
  exit 1
fi

# Node
current_major=0
if have node; then current_major="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  say "Installing Node $NODE_MAJOR"
  if have apt-get; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
    sudo -E bash /tmp/nodesource_setup.sh
    rm -f /tmp/nodesource_setup.sh
    sudo apt-get install -y nodejs
  else
    echo "Install Node $NODE_MAJOR or newer, then run this again." >&2
    exit 1
  fi
fi

# pnpm, through corepack (ships with Node)
if ! have pnpm || [ "$(pnpm --version)" != "$PNPM_VERSION" ]; then
  say "Setting up pnpm $PNPM_VERSION"
  if ! corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null; then sudo corepack enable; fi
  export PATH="$HOME/.local/bin:$PATH"
  corepack prepare "pnpm@$PNPM_VERSION" --activate
fi

say "Installing dependencies"
pnpm install --frozen-lockfile

say "Building"
pnpm build --filter=@poke/server... --filter=@poke/cli... --filter=@poke/mobile^...

say "Linking the poke command"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/apps/cli/dist/main.js" "$HOME/.local/bin/poke"
chmod +x "$ROOT/apps/cli/dist/main.js"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add ~/.local/bin to your PATH (Ubuntu does this at your next login)." ;;
esac

# Lets poke.service (a systemd user unit) run with nobody logged in.
if have loginctl && [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  say "Letting Poke run when you're logged out"
  sudo loginctl enable-linger "$USER" || echo "Run later: sudo loginctl enable-linger $USER"
fi

say "Done. Next: poke setup"
