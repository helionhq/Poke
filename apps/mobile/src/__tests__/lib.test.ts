import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../lib/base64";
import { accessHeaders, parsePairing } from "../lib/pairing";
import { signMessage } from "../lib/vaultKey";

ed.hashes.sha512 = sha512;

const payload = (obj: unknown) => toBase64Url(utf8(JSON.stringify(obj)));

describe("base64url", () => {
  it("round-trips bytes of every length", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
    }
  });

  it("matches Node's encoding", () => {
    const bytes = utf8("Poke ☀️ ünïcode");
    expect(toBase64Url(bytes)).toBe("UG9rZSDimIDvuI8gw7xuw69jb2Rl");
    expect(fromUtf8(fromBase64Url("aMOpbGxv"))).toBe("héllo");
  });
});

describe("parsePairing", () => {
  const good = { v: 1, url: "https://poke.example.com/", code: "abc-123" };

  it("reads the QR deep link", () => {
    expect(parsePairing(`poke://pair?d=${payload(good)}`)).toEqual({
      url: "https://poke.example.com",
      code: "abc-123",
    });
  });

  it("reads a bare payload and Cloudflare Access credentials", () => {
    const withAccess = { ...good, access: { clientId: "id.access", clientSecret: "s3cret" } };
    const code = parsePairing(payload(withAccess));
    expect(code?.access).toEqual({ clientId: "id.access", clientSecret: "s3cret" });
    expect(accessHeaders(code?.access)).toEqual({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "s3cret",
    });
  });

  it("reads a typed address and code", () => {
    expect(parsePairing("  https://poke.example.com  9F3-KQ2 ")).toEqual({
      url: "https://poke.example.com",
      code: "9F3-KQ2",
    });
  });

  it("rejects anything else", () => {
    expect(parsePairing("hello")).toBeUndefined();
    expect(parsePairing(`poke://pair?d=${payload({ ...good, v: 2 })}`)).toBeUndefined();
    expect(parsePairing(`poke://pair?d=${payload({ ...good, url: "javascript:alert(1)" })}`)).toBeUndefined();
    expect(parsePairing("poke://pair?d=not-json-at-all-not-json")).toBeUndefined();
  });
});

describe("signMessage", () => {
  it("makes a signature the server's Ed25519 check accepts", () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const message = "poke-vault-v1\nchl_1\nlist\n\nnonce";
    const signature = fromBase64Url(signMessage(secret, message));
    expect(signature).toHaveLength(64);
    expect(ed.verify(signature, utf8(message), ed.getPublicKey(secret))).toBe(true);
    expect(ed.verify(signature, utf8(`${message}x`), ed.getPublicKey(secret))).toBe(false);
  });
});
