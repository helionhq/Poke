import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { DomainError } from "@poke/domain";

/**
 * Fetches third-party images for the app (card images, app and site logos), so the phone never
 * contacts those hosts and nothing it loads can reach Poke's own network.
 *
 * - https only, default port only, at most 3 redirects (each re-checked).
 * - Every address the host resolves to must be public: no loopback, private, link-local,
 *   CGNAT/Tailscale (100.64/10), multicast or IPv6 ULA. The check runs inside the socket's own
 *   DNS lookup, so a rebinding host can't swap addresses between check and connect.
 * - Raster images only (no SVG: it can carry script), at most 5 MB, 8 s.
 * - Cached on disk by URL for a week.
 */
export interface ImageProxyOptions {
  cacheDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  ttlMs?: number;
  /** Tests: replaces DNS. */
  lookup?: (host: string) => Promise<string[]>;
  /** Tests: replaces the network fetch after the URL and addresses passed the checks. */
  fetchBytes?: (
    url: URL,
    address: string,
  ) => Promise<{ status: number; type?: string; location?: string; body: Buffer }>;
}

export interface ProxiedImage {
  type: string;
  body: Buffer;
}

const ALLOWED_TYPES = /^image\/(png|jpe?g|gif|webp|avif|heic|heif|x-icon|vnd\.microsoft\.icon|bmp|tiff)$/;
const META = ".type";

export class ImageProxy {
  readonly #opts: Required<Omit<ImageProxyOptions, "lookup" | "fetchBytes">> &
    Pick<ImageProxyOptions, "lookup" | "fetchBytes">;

  constructor(options: ImageProxyOptions) {
    this.#opts = { maxBytes: 5 * 1024 * 1024, timeoutMs: 8_000, ttlMs: 7 * 24 * 3600_000, ...options };
  }

  /** An image by URL (from a card the agent made). */
  async image(src: string): Promise<ProxiedImage> {
    const url = parseHttps(src);
    return this.#cached(url.href, () => this.#fetch(url, 0));
  }

  /** A site's logo by domain: its touch icon, else its favicon. */
  async logo(domain: string): Promise<ProxiedImage> {
    const host = domain.trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(host))
      throw new DomainError("invalid", "Not a domain");
    return this.#cached(`logo:${host}`, async () => {
      let last: unknown;
      for (const path of ["/apple-touch-icon.png", "/favicon.ico"]) {
        try {
          return await this.#fetch(new URL(`https://${host}${path}`), 0);
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof DomainError ? last : new DomainError("not_found", "No logo for that site");
    });
  }

  async #cached(key: string, load: () => Promise<ProxiedImage>): Promise<ProxiedImage> {
    const file = join(this.#opts.cacheDir, createHash("sha256").update(key).digest("hex"));
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < this.#opts.ttlMs) {
        const [body, type] = await Promise.all([readFile(file), readFile(file + META, "utf8")]);
        return { body, type };
      }
    } catch {
      // not cached yet
    }
    const image = await load();
    await mkdir(this.#opts.cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, image.body);
    await writeFile(file + META, image.type);
    await rename(tmp, file);
    return image;
  }

  async #fetch(url: URL, hops: number): Promise<ProxiedImage> {
    if (hops > 3) throw new DomainError("invalid", "Too many redirects");
    const addresses = await this.#resolve(url.hostname);
    const address = addresses[0]!;
    const res = this.#opts.fetchBytes ? await this.#opts.fetchBytes(url, address) : await this.#get(url);
    if (res.status >= 300 && res.status < 400 && res.location) {
      return this.#fetch(parseHttps(new URL(res.location, url).href), hops + 1);
    }
    if (res.status !== 200) throw new DomainError("not_found", `The image host answered ${res.status}`);
    const type = (res.type ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ALLOWED_TYPES.test(type)) throw new DomainError("invalid", "That isn't an image Poke can show");
    if (res.body.length > this.#opts.maxBytes) throw new DomainError("invalid", "That image is too large");
    return { type, body: res.body };
  }

  async #resolve(host: string): Promise<string[]> {
    if (isIP(host)) {
      if (!isPublicAddress(host)) throw new DomainError("invalid", "That address isn't public");
      return [host];
    }
    const all = this.#opts.lookup ? await this.#opts.lookup(host) : await lookupAll(host);
    if (all.length === 0) throw new DomainError("not_found", "That host doesn't resolve");
    if (!all.every(isPublicAddress)) throw new DomainError("invalid", "That host isn't public");
    return all;
  }

  #get(url: URL): Promise<{ status: number; type?: string; location?: string; body: Buffer }> {
    const { maxBytes, timeoutMs } = this.#opts;
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          headers: { "user-agent": "Poke image proxy", accept: "image/*" },
          timeout: timeoutMs,
          // The socket's own lookup: re-checks the addresses it will actually connect to.
          lookup: (hostname, options, callback) => {
            dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, found) => {
              if (error) return callback(error, "", 4);
              const list = found as unknown as LookupAddress[];
              const bad = list.find((a) => !isPublicAddress(a.address));
              if (bad || list.length === 0) return callback(new Error("Blocked a non-public address"), "", 4);
              if ((options as { all?: boolean }).all)
                return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
              callback(null, list[0]!.address, list[0]!.family);
            });
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return resolve({
              status,
              ...(res.headers.location ? { location: res.headers.location } : {}),
              body: Buffer.alloc(0),
            });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new DomainError("invalid", "That image is too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({
              status,
              ...(res.headers["content-type"] ? { type: res.headers["content-type"] } : {}),
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new DomainError("unavailable", "The image host took too long")));
      req.on("error", (error) =>
        reject(
          error instanceof DomainError ? error : new DomainError("unavailable", "Couldn't fetch that image"),
        ),
      );
      req.end();
    });
  }
}

function parseHttps(src: string): URL {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new DomainError("invalid", "Not a URL");
  }
  if (url.protocol !== "https:") throw new DomainError("invalid", "Only https images");
  if (url.port && url.port !== "443") throw new DomainError("invalid", "Only the default https port");
  if (url.username || url.password) throw new DomainError("invalid", "No credentials in image URLs");
  return url;
}

function lookupAll(host: string): Promise<string[]> {
  return new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (error, found) =>
      error
        ? reject(new DomainError("not_found", "That host doesn't resolve"))
        : resolve(found.map((a) => a.address)),
    ),
  );
}

/** True for globally routable unicast addresses only. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicV4(address);
  if (kind !== 6) return false;
  const a = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPublicV4(mapped[1]!);
  if (a === "::" || a === "::1") return false;
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8:") || a.startsWith("2002:")) return false;
  return (first & 0xe000) === 0x2000; // 2000::/3 global unicast
}

function isPublicV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, Tailscale
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
