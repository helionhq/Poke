import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A fix the CLI can offer to run. */
  fix?: { label: string; command: string; sudo?: boolean };
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<string | undefined> {
  try {
    const { stdout } = await run(cmd, args, { timeout });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function preflight(home: string, opts: { serverRunning?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];

  // OS
  if (process.platform === "linux" && existsSync("/etc/os-release")) {
    const osr = readFileSync("/etc/os-release", "utf8");
    const id = /^ID=(.*)$/m.exec(osr)?.[1]?.replace(/"/g, "");
    const version = /^VERSION_ID=(.*)$/m.exec(osr)?.[1]?.replace(/"/g, "");
    checks.push({
      id: "os",
      label: "Operating system",
      status: id === "ubuntu" && compareVersions(version ?? "0", "22.04") >= 0 ? "ok" : "warn",
      detail:
        `${id ?? "linux"} ${version ?? ""}`.trim() +
        (id === "ubuntu" ? "" : " (Poke is tested on Ubuntu 22.04+)"),
    });
  } else {
    checks.push({
      id: "os",
      label: "Operating system",
      status: "warn",
      detail: `${process.platform}: fine for development; Poke's machine should be Ubuntu`,
    });
  }

  // Node
  const node = process.versions.node;
  checks.push({
    id: "node",
    label: "Node.js",
    status: compareVersions(node, "22.19.0") >= 0 ? "ok" : "fail",
    detail: `v${node}${compareVersions(node, "22.19.0") >= 0 ? "" : " (needs ≥ 22.19)"}`,
  });

  // Docker + compose
  const docker = await sh("docker", ["version", "--format", "{{.Server.Version}}"]);
  checks.push(
    docker
      ? { id: "docker", label: "Docker", status: "ok", detail: `engine ${docker}` }
      : {
          id: "docker",
          label: "Docker",
          status: "fail",
          detail: "not installed or the daemon isn't reachable (Honcho, Bark and cloudflared run in Docker)",
          fix: {
            label: "Install Docker",
            command: "curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER",
            sudo: true,
          },
        },
  );
  const compose = await sh("docker", ["compose", "version", "--short"]);
  checks.push(
    compose
      ? { id: "compose", label: "Docker Compose", status: "ok", detail: `v${compose}` }
      : {
          id: "compose",
          label: "Docker Compose",
          status: docker ? "fail" : "warn",
          detail: "the compose plugin is missing",
        },
  );

  // Resources
  try {
    const fs = statfsSync(existsSync(home) ? home : process.cwd());
    const freeGb = (Number(fs.bavail) * Number(fs.bsize)) / 1e9;
    checks.push({
      id: "disk",
      label: "Disk",
      status: freeGb >= 20 ? "ok" : freeGb >= 5 ? "warn" : "fail",
      detail: `${freeGb.toFixed(1)} GB free`,
    });
  } catch {
    checks.push({ id: "disk", label: "Disk", status: "warn", detail: "couldn't read free space" });
  }
  const ramGb = totalmem() / 1e9;
  checks.push({
    id: "ram",
    label: "Memory",
    status: ramGb >= 8 ? "ok" : ramGb >= 4 ? "warn" : "fail",
    detail: `${ramGb.toFixed(1)} GB${ramGb >= 8 ? "" : " (8 GB+ recommended with Honcho)"}`,
  });

  // Ports
  if (!opts.serverRunning) {
    const free7070 = await portFree(7070);
    checks.push({
      id: "ports",
      label: "Port 7070",
      status: free7070 ? "ok" : "fail",
      detail: free7070 ? "free" : "in use by something else",
    });
  } else {
    checks.push({ id: "ports", label: "Port 7070", status: "ok", detail: "used by poke-server" });
  }

  // Tailscale (browse relay ↔ laptop)
  const tsIp = await sh("tailscale", ["ip", "-4"]);
  checks.push(
    tsIp
      ? { id: "tailscale", label: "Tailscale", status: "ok", detail: tsIp.split("\n")[0]! }
      : {
          id: "tailscale",
          label: "Tailscale",
          status: "warn",
          detail: "not installed or not up (needed for your browser via browse)",
          fix: {
            label: "Install Tailscale",
            command: "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up",
            sudo: true,
          },
        },
  );

  return checks;
}
