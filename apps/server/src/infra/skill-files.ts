import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { isValidSkillName, type SkillFiles, type SkillFolder } from "@poke/domain";

const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_DIRS = 2000;
const MAX_RESOURCES = 200;
const SKILL_MD = "SKILL.md";

export interface FsSkillFilesOptions {
  /** ~/poke/skills */
  root: string;
  /** Where downloads are unpacked before they're checked (~/poke/data/tmp). */
  staging: string;
  fetch?: typeof fetch;
}

/** Folders holding a SKILL.md under `dir`, depth- and count-bounded (agentskills.io/integrate-skills). */
function findSkills(dir: string): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (current: string, depth: number) => {
    if (depth > MAX_DEPTH || visited++ > MAX_DIRS) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === SKILL_MD)) {
      found.push(current);
      return; // a skill's own subfolders are its resources
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        walk(join(current, entry.name), depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

function folderOf(dir: string): SkillFolder {
  const location = join(dir, SKILL_MD);
  return { folder: basename(dir), text: readFileSync(location, "utf8"), location };
}

function unpack(archive: string, into: string): void {
  mkdirSync(into, { recursive: true });
  const attempts: Array<[string, string[]]> = [["tar", ["-xf", archive, "-C", into]]];
  if (/\.zip$/i.test(archive))
    attempts.push(
      ["unzip", ["-q", "-o", archive, "-d", into]],
      ["python3", ["-m", "zipfile", "-e", archive, into]],
    );
  for (const [command, args] of attempts) {
    if (spawnSync(command, args, { stdio: "ignore" }).status === 0) return;
  }
  throw new Error("Couldn't unpack that archive");
}

/** The skills folder on Poke's machine, and installing into it from URLs, archives and folders. */
export class FsSkillFiles implements SkillFiles {
  readonly root: string;
  readonly #stages = new Map<string, { dir: string; folders: Map<string, string> }>();

  constructor(private readonly options: FsSkillFilesOptions) {
    this.root = options.root;
    mkdirSync(this.root, { recursive: true });
  }

  async scan(): Promise<SkillFolder[]> {
    const out: SkillFolder[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(this.root, entry.name);
      if (existsSync(join(dir, SKILL_MD))) out.push(folderOf(dir));
    }
    return out;
  }

  async stage(source: string): Promise<{ id: string; skills: SkillFolder[] }> {
    const id = randomBytes(8).toString("hex");
    const dir = join(this.options.staging, `skill-${id}`);
    mkdirSync(dir, { recursive: true });
    try {
      const root = await this.#fetchInto(source.trim(), dir);
      const dirs = findSkills(root);
      const folders = new Map<string, string>();
      const skills = dirs.map((d) => {
        const folder = folderOf(d);
        folders.set(folder.folder, d);
        return folder;
      });
      this.#stages.set(id, { dir, folders });
      return { id, skills };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async commit(stageId: string, folder: string, name: string): Promise<string> {
    if (!isValidSkillName(name)) throw new Error(`"${name}" isn't a valid skill name`);
    const from = this.#stages.get(stageId)?.folders.get(folder);
    if (!from) throw new Error(`Nothing staged for ${folder}`);
    const to = join(this.root, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    return join(to, SKILL_MD);
  }

  async discard(stageId: string): Promise<void> {
    const stage = this.#stages.get(stageId);
    this.#stages.delete(stageId);
    if (stage) rmSync(stage.dir, { recursive: true, force: true });
  }

  async remove(name: string): Promise<void> {
    if (!isValidSkillName(name)) throw new Error(`"${name}" isn't a valid skill name`);
    rmSync(join(this.root, name), { recursive: true, force: true });
  }

  async resources(name: string): Promise<string[]> {
    if (!isValidSkillName(name)) return [];
    const base = join(this.root, name);
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || out.length >= MAX_RESOURCES) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile() && !(dir === base && entry.name === SKILL_MD))
          out.push(relative(base, path).split(sep).join("/"));
        if (out.length >= MAX_RESOURCES) return;
      }
    };
    if (existsSync(base)) walk(base, 0);
    return out.sort();
  }

  /** Puts the source's files under `dir` and returns where to look for skills. */
  async #fetchInto(source: string, dir: string): Promise<string> {
    if (isAbsolute(source)) {
      if (!existsSync(source)) throw new Error(`Nothing at ${source}`);
      if (statSync(source).isDirectory()) {
        const to = join(dir, basename(source));
        cpSync(source, to, { recursive: true });
        return dir;
      }
      if (basename(source).toLowerCase().endsWith(".md"))
        return this.#single(readFileSync(source, "utf8"), dir, basename(dirname(source)));
      unpack(source, join(dir, "unpacked"));
      return dir;
    }
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("Give a URL, an attachment or an absolute folder path");
    }
    if (url.protocol !== "https:") throw new Error("Only https URLs can be installed from");

    const github =
      url.hostname === "github.com"
        ? /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(url.pathname)
        : null;
    if (github) {
      const [, owner, repo, kind, ref, path = ""] = github;
      const tarball = `https://api.github.com/repos/${owner}/${repo}/tarball${ref ? `/${ref}` : ""}`;
      const archive = join(dir, "source.tar.gz");
      writeFileSync(archive, await this.#download(tarball));
      const unpacked = join(dir, "unpacked");
      unpack(archive, unpacked);
      const [top] = readdirSync(unpacked);
      if (!top) throw new Error("That repository is empty");
      const sub = kind === "blob" ? dirname(path) : path;
      const target = join(unpacked, top, ...sub.split("/").filter((p) => p && p !== "." && p !== ".."));
      if (!existsSync(target)) throw new Error(`No ${sub} in that repository`);
      return target;
    }

    const body = await this.#download(url.toString());
    const ext = extname(url.pathname).toLowerCase();
    if (
      ext === ".zip" ||
      ext === ".tgz" ||
      ext === ".tar" ||
      url.pathname.toLowerCase().endsWith(".tar.gz")
    ) {
      const archive = join(dir, `source${url.pathname.toLowerCase().endsWith(".tar.gz") ? ".tar.gz" : ext}`);
      writeFileSync(archive, body);
      unpack(archive, join(dir, "unpacked"));
      return dir;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return this.#single(body.toString("utf8"), dir, segments.at(-2) ?? "skill");
  }

  /** A lone SKILL.md: its folder is named after its frontmatter name, or the URL/file's folder. */
  #single(text: string, dir: string, fallback: string): string {
    const named = /^name:\s*["']?([a-z0-9-]{1,64})["']?\s*$/m.exec(text)?.[1];
    const folder = named ?? (isValidSkillName(fallback) ? fallback : "skill");
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, SKILL_MD), text);
    return dir;
  }

  async #download(url: string): Promise<Buffer> {
    const response = await (this.options.fetch ?? fetch)(url, {
      headers: { "user-agent": "poke-skill-installer" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`.trim());
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD) throw new Error("That download is too big for a skill");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_DOWNLOAD) throw new Error("That download is too big for a skill");
    return data;
  }
}
