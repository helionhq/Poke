import { publicDevice } from "@poke/application";
import type { PairingPayload } from "@poke/contracts";
import type { Context } from "../admin.js";
import { ago, dim, ok, p, pc, printJson, qr, table, unwrap } from "../ui.js";

interface IssuedCode {
  code: string;
  expiresAt: number;
  url?: string;
}

export async function issuePairing(ctx: Context): Promise<IssuedCode> {
  if (await ctx.online()) return ctx.admin.call<IssuedCode>("POST", "/admin/pairing-code");
  const kernel = ctx.local();
  return { ...kernel.devices.issuePairingCode(), url: kernel.settings.get("public.url") };
}

export function pairingLink(issued: IssuedCode, fallbackUrl: string): string {
  const payload: PairingPayload = { v: 1, url: issued.url ?? fallbackUrl, code: issued.code };
  return `poke://pair?d=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

/** Print a QR code the Poke app scans to pair this phone. */
export async function pairPhone(ctx: Context, opts: { json?: boolean } = {}): Promise<void> {
  const issued = await issuePairing(ctx);
  const link = pairingLink(issued, "https://poke.arham.im");
  if (opts.json) {
    printJson({ ...issued, link });
    return;
  }
  const minutes = Math.round((issued.expiresAt - Date.now()) / 60000);
  p.note(
    `${await qr(link)}\nOpen Poke on your iPhone and scan this code.\n` +
      `Or enter it by hand: ${pc.bold(issued.code)}  ${dim(`(${issued.url ?? ""}, valid ${minutes} min, single use)`)}`,
    "Pair a phone",
  );
}

type DeviceRow = ReturnType<typeof publicDevice>;

async function listDevices(ctx: Context): Promise<DeviceRow[]> {
  if (await ctx.online())
    return (await ctx.admin.call<{ devices: DeviceRow[] }>("GET", "/v1/devices")).devices;
  return ctx.local().devices.list().map(publicDevice);
}

async function revokeDevice(ctx: Context, id: string): Promise<void> {
  if (await ctx.online()) await ctx.admin.call("DELETE", `/v1/devices/${id}`);
  else ctx.local().devices.revoke(id);
}

export async function devicesMenu(ctx: Context): Promise<void> {
  const action = unwrap(
    await p.select({
      message: "Devices",
      options: [
        { value: "pair", label: "Pair a new phone", hint: "QR code" },
        { value: "list", label: "List devices" },
        { value: "revoke", label: "Revoke a device" },
      ],
    }),
  );
  if (action === "pair") return pairPhone(ctx);
  const devices = await listDevices(ctx);
  if (action === "list") {
    printDevices(devices);
    return;
  }
  const live = devices.filter((d) => d.revokedAt === undefined);
  if (live.length === 0) {
    p.log.info("No active devices.");
    return;
  }
  const id = unwrap(
    await p.select({
      message: "Revoke which device?",
      options: live.map((d) => ({
        value: d.id,
        label: d.name,
        hint: `${d.platform} · last seen ${ago(d.lastSeenAt)}`,
      })),
    }),
  );
  await revokeDevice(ctx, id);
  p.log.success(ok("Revoked. That device's token no longer works."));
}

export function printDevices(devices: DeviceRow[]): void {
  if (devices.length === 0) {
    p.log.info("No devices paired yet. Pair one with `poke config devices pair`.");
    return;
  }
  const rows = [["NAME", "PLATFORM", "SCOPE", "LAST SEEN", "STATUS"].map((h) => pc.dim(h))];
  for (const d of devices) {
    rows.push([
      d.name,
      d.platform,
      d.scope,
      ago(d.lastSeenAt),
      d.revokedAt ? pc.red("revoked") : pc.green("active"),
    ]);
  }
  console.log(table(rows));
}

export async function devicesCommand(
  ctx: Context,
  action: string | undefined,
  arg: string | undefined,
  opts: { json?: boolean },
) {
  switch (action) {
    case undefined:
      return devicesMenu(ctx);
    case "pair":
      return pairPhone(ctx, opts);
    case "list": {
      const devices = await listDevices(ctx);
      if (opts.json) printJson(devices);
      else printDevices(devices);
      return;
    }
    case "revoke":
      if (!arg) throw new Error("Usage: poke config devices revoke <device-id>");
      await revokeDevice(ctx, arg);
      if (!opts.json) console.log(ok(`Revoked ${arg}`));
      return;
    default:
      throw new Error(`Unknown devices action "${action}" (pair, list, revoke)`);
  }
}
