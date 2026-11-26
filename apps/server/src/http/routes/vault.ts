import {
  VaultAddRequest,
  VaultChallenge,
  VaultChallengeRequest,
  VaultEditRequest,
  VaultEntryResponse,
  VaultList,
  VaultReveal,
} from "@poke/contracts";
import { type Device, DomainError } from "@poke/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { type VaultAction, proofMessage, VaultProofs, vaultPurpose } from "../../infra/vault-proof.js";
import { requireStack, type Services } from "../../services.js";
import { type Principal, route, type Surface } from "../route.js";

const NameParams = z.object({ name: z.string().min(1).max(64) });
const PROOF_HEADER = "x-poke-vault-proof";

/**
 * The Vault screen (section 10): list, add, edit, delete and reveal, each behind a fresh Face ID
 * proof from a phone that enrolled a key at pairing. Never on the admin socket, never for agents.
 */
export function registerVaultRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  const proofs = new VaultProofs(s.clock);
  const phone = (principal: Principal): Device => {
    if (principal.kind !== "device")
      throw new DomainError("forbidden", "The vault opens only on a paired phone, with Face ID");
    return principal.device;
  };
  const check = (principal: Principal, req: FastifyRequest, action: VaultAction, name?: string) => {
    const header = req.headers[PROOF_HEADER];
    proofs.verify(phone(principal), Array.isArray(header) ? header[0] : header, vaultPurpose(action, name));
  };

  route(
    app,
    {
      method: "POST",
      url: "/v1/vault/challenge",
      auth: "device",
      body: VaultChallengeRequest,
      response: VaultChallenge,
      summary: "A one-time challenge to sign after Face ID",
    },
    ({ body, principal }) => {
      const device = phone(principal);
      const purpose = vaultPurpose(body.action, body.name);
      const challenge = proofs.issue(device, purpose);
      return {
        ...challenge,
        message: proofMessage(device.id, challenge.challengeId, challenge.nonce, purpose),
      };
    },
  );
  route(
    app,
    {
      method: "GET",
      url: "/v1/vault",
      auth: "device",
      response: VaultList,
      summary: "Vault entries (no values)",
    },
    ({ principal, req }) => {
      check(principal, req, "list");
      return { entries: requireStack(s).vault.list() };
    },
  );
  route(
    app,
    {
      method: "POST",
      url: "/v1/vault/entries",
      auth: "device",
      body: VaultAddRequest,
      response: VaultEntryResponse,
    },
    ({ body, principal, req }) => {
      check(principal, req, "add", body.name);
      const vault = requireStack(s).vault;
      if (vault.get(body.name)) throw new DomainError("conflict", `${body.name} already exists`);
      const entry = vault.put({
        name: body.name,
        kind: body.kind,
        secrets: body.secrets,
        ...(body.fields ? { fields: body.fields } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.kind === "code" ? { ephemeral: true } : {}),
      });
      return { entry };
    },
  );
  route(
    app,
    {
      method: "PATCH",
      url: "/v1/vault/entries/:name",
      auth: "device",
      params: NameParams,
      body: VaultEditRequest,
      response: VaultEntryResponse,
    },
    ({ params, body, principal, req }) => {
      check(principal, req, "edit", params.name);
      const vault = requireStack(s).vault;
      if (!vault.get(params.name)) throw new DomainError("not_found", `No vault entry named ${params.name}`);
      return { entry: vault.update(params.name, body) };
    },
  );
  route(
    app,
    { method: "DELETE", url: "/v1/vault/entries/:name", auth: "device", params: NameParams },
    ({ params, principal, req }) => {
      check(principal, req, "delete", params.name);
      if (!requireStack(s).vault.delete(params.name))
        throw new DomainError("not_found", `No vault entry named ${params.name}`);
      return { deleted: true };
    },
  );
  route(
    app,
    {
      method: "POST",
      url: "/v1/vault/entries/:name/reveal",
      auth: "device",
      params: NameParams,
      response: VaultReveal,
      summary: "The entry's secret values, for the phone's eyes only",
    },
    ({ params, principal, req, reply }) => {
      check(principal, req, "reveal", params.name);
      void reply.header("cache-control", "no-store");
      return { secrets: requireStack(s).vault.reveal(params.name) };
    },
  );
}
