// Writes release.json next to an IPA (runs on the macOS release job). The Poke server turns it
// into the SideStore source: SideStore refuses an install whose entitlements or usage
// descriptions differ from what the source lists, so they are read from the built app itself.
//
// node release-json.mjs <Poke.app> <Poke.entitlements> <out.json>
// env: BUILD_NUMBER, COMMIT, FINGERPRINT
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [app, entitlementsFile, out] = process.argv.slice(2);
if (!app || !entitlementsFile || !out) {
  console.error("usage: node release-json.mjs <Poke.app> <Poke.entitlements> <out.json>");
  process.exit(2);
}

const plist = (file) =>
  JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));

const info = plist(`${app}/Info.plist`);
const entitlements = existsSync(entitlementsFile) ? plist(entitlementsFile) : {};
const privacy = Object.fromEntries(
  Object.entries(info).filter(
    ([key, value]) => /^NS\w+UsageDescription$/.test(key) && typeof value === "string",
  ),
);

const release = {
  version: info.CFBundleShortVersionString,
  buildVersion: String(process.env.BUILD_NUMBER ?? info.CFBundleVersion),
  date: new Date().toISOString(),
  commit: process.env.COMMIT,
  fingerprint: process.env.FINGERPRINT,
  minOSVersion: info.MinimumOSVersion,
  permissions: { entitlements: Object.keys(entitlements).sort(), privacy },
};
writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
