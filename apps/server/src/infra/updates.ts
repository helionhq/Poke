import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Poke's own update server (brief section 23). `poke update` puts things here; the server only
 * reads them.
 *
 *   <updates>/ota/<runtimeVersion>/<createdAt ms>-<commit>/   an `expo export` of the app, plus
 *       expoConfig.json (the resolved app config) and update.json ({ createdAt, commit })
 *   <updates>/ipa/<buildVersion>/Poke.ipa + release.json       a native build from CI
 */

export interface OtaAsset {
  hash: string;
  key: string;
  contentType: string;
  fileExtension?: string;
  url: string;
}

export interface OtaManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  launchAsset: OtaAsset;
  assets: OtaAsset[];
  metadata: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface OtaUpdate {
  runtimeVersion: string;
  /** Folder name under the runtime version. */
  dir: string;
  createdAt: number;
  commit?: string;
}

/** What CI wrote next to an IPA (release.json). */
export interface IpaRelease {
  version: string;
  buildVersion: string;
  /** ISO 8601. */
  date: string;
  commit?: string;
  fingerprint?: string;
  minOSVersion?: string;
  /** Entitlements and *UsageDescription keys, as SideStore checks them. */
  permissions?: { entitlements: string[]; privacy: Record<string, string> };
}

const CONTENT_TYPES: Record<string, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

const RUNTIME = /^[A-Za-z0-9._-]{1,128}$/;
const BUILD = /^[0-9]{1,9}$/;

export class UpdateStore {
  readonly #ota: string;
  readonly #ipa: string;

  constructor(root: string) {
    this.#ota = join(root, "ota");
    this.#ipa = join(root, "ipa");
  }

  /** The newest update for a runtime version, or undefined. */
  latest(runtimeVersion: string): OtaUpdate | undefined {
    if (!RUNTIME.test(runtimeVersion)) return undefined;
    const base = join(this.#ota, runtimeVersion);
    if (!existsSync(base)) return undefined;
    const updates = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(base, d.name, "metadata.json")))
      .map((d) => {
        const info =
          readJson<{ createdAt?: number; commit?: string }>(join(base, d.name, "update.json")) ?? {};
        const createdAt = info.createdAt ?? Number.parseInt(d.name, 10);
        return {
          runtimeVersion,
          dir: d.name,
          createdAt: Number.isFinite(createdAt) ? createdAt : statSync(join(base, d.name)).mtimeMs,
          ...(info.commit ? { commit: info.commit } : {}),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    return updates[0];
  }

  /** The expo-updates manifest for an update; asset URLs point at `assetUrl(path)`. */
  manifest(update: OtaUpdate, assetUrl: (path: string) => string): OtaManifest {
    const dir = join(this.#ota, update.runtimeVersion, update.dir);
    const metadataText = readFileSync(join(dir, "metadata.json"), "utf8");
    const metadata = JSON.parse(metadataText) as {
      fileMetadata: { ios?: { bundle: string; assets: Array<{ path: string; ext: string }> } };
    };
    const ios = metadata.fileMetadata.ios;
    if (!ios) throw new Error(`The update in ${dir} has no iOS bundle`);
    const asset = (path: string, ext: string | undefined, launch: boolean): OtaAsset => {
      const rel = path.replaceAll("\\", "/");
      const bytes = readFileSync(this.#inside(dir, rel));
      return {
        hash: createHash("sha256").update(bytes).digest("base64url"),
        key: createHash("md5").update(bytes).digest("hex"),
        contentType: launch
          ? "application/javascript"
          : (CONTENT_TYPES[ext ?? ""] ?? "application/octet-stream"),
        ...(launch ? {} : ext ? { fileExtension: `.${ext}` } : {}),
        url: assetUrl(`${update.runtimeVersion}/${update.dir}/${rel}`),
      };
    };
    const expoConfig = readJson<Record<string, unknown>>(join(dir, "expoConfig.json"));
    return {
      // A UUID made from the metadata's hash: the same export always has the same id.
      id: uuidFromHash(createHash("sha256").update(metadataText).digest("hex")),
      createdAt: new Date(update.createdAt).toISOString(),
      runtimeVersion: update.runtimeVersion,
      launchAsset: asset(ios.bundle, undefined, true),
      assets: ios.assets.map((a) => asset(a.path, a.ext, false)),
      metadata: {},
      extra: {
        ...(expoConfig ? { expoClient: expoConfig } : {}),
        ...(update.commit ? { commit: update.commit } : {}),
      },
    };
  }

  /** The file behind an asset URL path (`<runtime>/<dir>/<file>`), kept inside the store. */
  assetFile(path: string): { file: string; contentType: string } | undefined {
    const [runtimeVersion, dir, ...rest] = path.split("/");
    if (!runtimeVersion || !dir || rest.length === 0 || !RUNTIME.test(runtimeVersion)) return undefined;
    try {
      const file = this.#inside(join(this.#ota, runtimeVersion, dir), rest.join("/"));
      if (!statSync(file).isFile()) return undefined;
      const ext = file.split(".").pop() ?? "";
      const launch = file.includes(`${sep}_expo${sep}static${sep}js${sep}`);
      return {
        file,
        contentType: launch ? "application/javascript" : (CONTENT_TYPES[ext] ?? "application/octet-stream"),
      };
    } catch {
      return undefined;
    }
  }

  /** Native builds, newest first. */
  releases(): Array<IpaRelease & { file: string; size: number }> {
    if (!existsSync(this.#ipa)) return [];
    return readdirSync(this.#ipa, { withFileTypes: true })
      .filter((d) => d.isDirectory() && BUILD.test(d.name))
      .flatMap((d) => {
        const file = join(this.#ipa, d.name, "Poke.ipa");
        const release = readJson<IpaRelease>(join(this.#ipa, d.name, "release.json"));
        if (!release || !existsSync(file)) return [];
        return [{ ...release, buildVersion: d.name, file, size: statSync(file).size }];
      })
      .sort((a, b) => Number(b.buildVersion) - Number(a.buildVersion));
  }

  release(buildVersion: string): (IpaRelease & { file: string; size: number }) | undefined {
    if (!BUILD.test(buildVersion)) return undefined;
    return this.releases().find((r) => r.buildVersion === buildVersion);
  }

  /** `path` resolved under `root` through symlinks; throws if it would leave it. */
  #inside(root: string, path: string): string {
    const realRoot = realpathSync(root);
    const full = realpathSync(resolve(realRoot, path));
    const rel = relative(realRoot, full);
    if (rel.startsWith("..") || resolve(realRoot, rel) !== full) throw new Error("outside the update");
    return full;
  }
}

/**
 * The AltStore source SideStore reads (faq.altstore.io/developers/make-a-source): one app, its
 * builds newest first. Download URLs carry the source token, the only credential these routes have.
 */
export function sideStoreSource(input: {
  baseUrl: string;
  token: string;
  releases: Array<IpaRelease & { size: number }>;
}): Record<string, unknown> {
  const root = `${input.baseUrl}/sidestore/${input.token}`;
  const newest = input.releases[0];
  return {
    name: "Poke",
    subtitle: "Your own agent",
    description: "Poke's iPhone app, built from your server's code.",
    iconURL: `${input.baseUrl}/icon.png`,
    tintColor: "#1C1C1E",
    apps: [
      {
        name: "Poke",
        bundleIdentifier: "im.arham.poke",
        developerName: "Poke",
        subtitle: "Your own agent",
        localizedDescription: "Talk to Poke, see what it's working on, and keep your vault behind Face ID.",
        iconURL: `${input.baseUrl}/icon.png`,
        tintColor: "#1C1C1E",
        category: "utilities",
        screenshots: [],
        appPermissions: newest?.permissions ?? { entitlements: [], privacy: {} },
        versions: input.releases.map((r) => ({
          version: r.version,
          buildVersion: r.buildVersion,
          date: r.date,
          ...(r.commit ? { localizedDescription: `Built from ${r.commit.slice(0, 7)}.` } : {}),
          downloadURL: `${root}/Poke-${r.version}-${r.buildVersion}.ipa`,
          size: r.size,
          ...(r.minOSVersion ? { minOSVersion: r.minOSVersion } : {}),
        })),
      },
    ],
    news: [],
  };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function uuidFromHash(hex: string): string {
  const h = hex.slice(0, 32).split("");
  h[12] = "4"; // version
  h[16] = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
