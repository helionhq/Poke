import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageProxy, isPublicAddress } from "./image-proxy.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function proxy(
  dns: Record<string, string[]>,
  pages: Record<string, { status: number; type?: string; location?: string; body?: Buffer }>,
) {
  const dir = mkdtempSync(join(tmpdir(), "poke-img-"));
  dirs.push(dir);
  const fetched: string[] = [];
  const p = new ImageProxy({
    cacheDir: dir,
    lookup: async (host) => dns[host] ?? [],
    fetchBytes: async (url) => {
      fetched.push(url.href);
      const page = pages[url.href];
      if (!page) return { status: 404, body: Buffer.alloc(0) };
      return { ...page, body: page.body ?? Buffer.alloc(0) };
    },
  });
  return { p, fetched };
}

describe("isPublicAddress", () => {
  it("allows public addresses and blocks private, local and Tailscale ones", () => {
    for (const ok of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "192.0.3.1"])
      expect(isPublicAddress(ok)).toBe(true);
    for (const bad of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fd7a:115c:a1e0::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ])
      expect(isPublicAddress(bad), bad).toBe(false);
  });
});

describe("ImageProxy", () => {
  it("fetches and caches a public image", async () => {
    const { p, fetched } = proxy(
      { "cdn.example.com": ["93.184.216.34"] },
      { "https://cdn.example.com/a.png": { status: 200, type: "image/png", body: PNG } },
    );
    expect((await p.image("https://cdn.example.com/a.png")).type).toBe("image/png");
    await p.image("https://cdn.example.com/a.png");
    expect(fetched).toHaveLength(1);
  });

  it("refuses non-https, odd ports, credentials and private hosts", async () => {
    const { p } = proxy(
      { "internal.example.com": ["10.0.0.5"], "mixed.example.com": ["93.184.216.34", "127.0.0.1"] },
      {},
    );
    await expect(p.image("http://cdn.example.com/a.png")).rejects.toThrow(/https/);
    await expect(p.image("https://cdn.example.com:8443/a.png")).rejects.toThrow(/port/);
    await expect(p.image("https://u:p@cdn.example.com/a.png")).rejects.toThrow(/credentials/);
    await expect(p.image("https://internal.example.com/a.png")).rejects.toThrow(/public/);
    await expect(p.image("https://mixed.example.com/a.png")).rejects.toThrow(/public/);
    await expect(p.image("https://100.101.102.103/a.png")).rejects.toThrow(/public/);
  });

  it("re-checks redirects and refuses SVG", async () => {
    const { p } = proxy(
      { "a.example.com": ["93.184.216.34"], "b.example.com": ["192.168.0.2"] },
      {
        "https://a.example.com/r": { status: 302, location: "https://b.example.com/x.png" },
        "https://a.example.com/s.svg": { status: 200, type: "image/svg+xml", body: Buffer.from("<svg/>") },
      },
    );
    await expect(p.image("https://a.example.com/r")).rejects.toThrow(/public/);
    await expect(p.image("https://a.example.com/s.svg")).rejects.toThrow(/image Poke can show/);
  });

  it("finds a site's logo, falling back to its favicon", async () => {
    const { p, fetched } = proxy(
      { "resy.com": ["93.184.216.34"] },
      { "https://resy.com/favicon.ico": { status: 200, type: "image/x-icon", body: PNG } },
    );
    expect((await p.logo("Resy.com")).type).toBe("image/x-icon");
    expect(fetched).toEqual(["https://resy.com/apple-touch-icon.png", "https://resy.com/favicon.ico"]);
    await expect(p.logo("localhost")).rejects.toThrow(/domain/);
  });
});
