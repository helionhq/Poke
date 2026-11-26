import { z } from "zod";
import {
  ApprovalRequest,
  ApprovalRule,
  Attachment,
  Block,
  Device,
  Message,
  Routine,
  RoutineRun,
  Skill,
  Step,
  Task,
  Trace,
  VaultEntry,
} from "./entities.js";

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ── Health / pairing ───────────────────────────────────────────────────────

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  protocol: z.number(),
  uptimeSec: z.number(),
});

export const PairRequest = z.object({
  code: z.string().min(4).max(64),
  deviceName: z.string().min(1).max(80),
  platform: z.enum(["ios", "web", "cli", "shortcut"]),
  /**
   * The phone's Ed25519 public key (32 bytes, base64url) for the vault. Its private half stays in
   * the Keychain behind Face ID; vault requests are signed with it.
   */
  vaultKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "a 32-byte Ed25519 public key in base64url")
    .optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({ token: z.string(), device: Device });
export type PairResponse = z.infer<typeof PairResponse>;

/** What the QR code holds: `poke://pair?d=<base64url(JSON)>`. */
export const PairingPayload = z.object({
  v: z.literal(1),
  url: z.url(),
  code: z.string(),
  /** Optional Cloudflare Access service-token headers for the client to send. */
  access: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
});
export type PairingPayload = z.infer<typeof PairingPayload>;

// ── Thread ────────────────────────────────────────────────────────────────

export const ThreadPageQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  around: z.string().optional(),
});

/** Normalised: blocks and traces referenced by the page's parts come alongside. */
export const ThreadPage = z.object({
  messages: z.array(Message),
  blocks: z.array(Block),
  traces: z.array(Trace),
  before: z.string().optional(),
  latestSeq: z.number(),
});
export type ThreadPage = z.infer<typeof ThreadPage>;

export const ThreadInfo = z.object({
  since: z.number().optional(),
  messageCount: z.number(),
  latestSeq: z.number(),
  pokeModelSet: z.boolean(),
  /** How many vault entries there are (the agent sheet shows the count; names stay behind Face ID). */
  vaultCount: z.number().optional(),
});
export type ThreadInfo = z.infer<typeof ThreadInfo>;

export const SendMessageRequest = z.object({
  text: z.string().max(100_000).default(""),
  clientMessageId: z.string().min(8).max(100),
  attachmentIds: z.array(z.string()).max(20).default([]),
  replyTo: z.string().optional(),
  /** Per-turn facts from the device (location, local time) — never cached in the prompt. */
  context: z.object({ timezone: z.string().optional(), location: z.string().optional() }).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({ message: Message, duplicate: z.boolean() });

export const SearchQuery = z.object({
  q: z.string().min(1),
  filter: z.enum(["all", "messages", "tasks", "links", "photos"]).default("all"),
  before: z.coerce.number().optional(),
  after: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  history: z.coerce.boolean().default(true),
});

export const SearchResponse = z.object({
  history: z.object({ answer: z.string(), mentions: z.number() }).optional(),
  hits: z.array(
    z.object({
      messageId: z.string(),
      role: z.enum(["user", "poke", "system"]),
      kind: z.enum(["message", "task", "link", "photo"]),
      highlight: z.string(),
      createdAt: z.number(),
      url: z.string().optional(),
      attachmentId: z.string().optional(),
    }),
  ),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const TraceDetail = z.object({ trace: Trace, steps: z.array(Step), tasks: z.array(Task) });

// ── Attachments ───────────────────────────────────────────────────────────

export const UploadResponse = z.object({ attachment: Attachment });

export const ShareResponse = z.object({ messageId: z.string(), deepLink: z.string() });

// ── Library ───────────────────────────────────────────────────────────────

export const LibraryQuery = z.object({
  filter: z.enum(["all", "photos", "files", "from_poke"]).default("all"),
  q: z.string().max(200).optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export const LibraryList = z.object({ attachments: z.array(Attachment) });
export type LibraryList = z.infer<typeof LibraryList>;

/** One entry in Poke's workspace folder, browsed from the Library. */
export const WorkspaceEntry = z.object({
  name: z.string(),
  /** Path relative to the workspace root, with forward slashes. */
  path: z.string(),
  kind: z.enum(["dir", "file"]),
  size: z.number().optional(),
  modifiedAt: z.number(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;
export const WorkspaceQuery = z.object({ path: z.string().max(1000).default("") });
export const WorkspaceListing = z.object({ path: z.string(), entries: z.array(WorkspaceEntry) });
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

// ── Devices ───────────────────────────────────────────────────────────────

export const DeviceList = z.object({ devices: z.array(Device) });

export const ShareTokenResponse = z.object({ token: z.string(), device: Device });

// ── blocks (section 9) ───────────────────────────────────────────────────────────────────────

/**
 * An action on a block. `clientActionId` makes it idempotent: a retry gets the first answer.
 * A secret_request `save` payload holds the secret; the server writes it to the vault and never
 * stores, logs or echoes it.
 */
export const BlockActionRequest = z.object({
  action: z.string().min(1).max(40),
  payload: z.record(z.string(), z.unknown()).optional(),
  clientActionId: z.string().min(8).max(80),
});
export type BlockActionRequest = z.infer<typeof BlockActionRequest>;

export const BlockActionResponse = z.object({
  block: Block,
  /** e.g. `{url}` to open for a connect_request `connect`. */
  result: z.record(z.string(), z.unknown()).optional(),
  duplicate: z.boolean(),
});
export type BlockActionResponse = z.infer<typeof BlockActionResponse>;

export const BlockResponse = z.object({ block: Block });

// ── vault (section 10): every call carries a Face ID proof ───────────────────────────────────

export const VaultAction = z.enum(["list", "add", "edit", "delete", "reveal"]);
const VaultName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "lowercase letters, digits, . _ -");
const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/** Ask for a challenge, sign it after Face ID, send it as `X-Poke-Vault-Proof: <id>.<signature>`. */
export const VaultChallengeRequest = z.object({ action: VaultAction, name: VaultName.optional() });
export const VaultChallenge = z.object({
  challengeId: z.string(),
  nonce: z.string(),
  expiresAt: z.number(),
  /** Sign the UTF-8 bytes of this with the device's Ed25519 key. */
  message: z.string(),
});
export const VaultList = z.object({ entries: z.array(VaultEntry) });
export const VaultAddRequest = z.object({
  name: VaultName,
  kind: z.enum(["login", "api_key", "card", "code", "note"]),
  fields: z.record(FieldName, z.string().max(500)).optional(),
  secrets: z.record(FieldName, z.string().min(1).max(8192)),
  description: z.string().max(300).optional(),
});
export const VaultEditRequest = z.object({
  fields: z.record(FieldName, z.string().max(500)).optional(),
  secrets: z.record(FieldName, z.string().min(1).max(8192)).optional(),
  description: z.string().max(300).optional(),
});
export const VaultEntryResponse = z.object({ entry: VaultEntry });
export const VaultReveal = z.object({ secrets: z.record(z.string(), z.string()) });

// ── approvals (section 12) ───────────────────────────────────────────────────────────────────

export const ApprovalRuleList = z.object({ rules: z.array(ApprovalRule) });
export const PendingApprovals = z.object({ approvals: z.array(ApprovalRequest) });

// ── Integrations (milestone 6) ───────────────────────────────────────────────────────────────

export const IntegrationAccount = z.object({
  id: z.string(),
  appId: z.string(),
  label: z.string(),
  identity: z.string().optional(),
  status: z.enum(["connected", "pending", "error"]),
});

export const Integration = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(["executor", "mcp"]),
  icon: z.string().optional(),
  category: z.string().optional(),
  custom: z.object({ from: z.string(), toolCount: z.number().optional() }).optional(),
  accounts: z.array(IntegrationAccount),
  defaultAccountId: z.string().optional(),
  capabilities: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      tools: z.array(z.string()),
      mode: z.enum(["on", "off", "ask"]),
    }),
  ),
  connectedAt: z.number().optional(),
});

export const IntegrationList = z.object({
  integrations: z.array(Integration),
  executor: z.object({ configured: z.boolean() }),
});

export const CatalogApp = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  icon: z.string().optional(),
  auth: z.array(z.object({ method: z.string(), kind: z.string(), label: z.string().optional() })),
});
export const CatalogList = z.object({ apps: z.array(CatalogApp) });

/** Headers and env hold `{{vault:…}}` placeholders for secrets, never values. */
export const McpTransport = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1).max(300),
    args: z.array(z.string().max(500)).max(30),
    env: z.record(z.string(), z.string().max(2000)).optional(),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.url(),
    headers: z.record(z.string(), z.string().max(2000)).optional(),
  }),
]);

export const McpServer = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransport,
  enabled: z.boolean(),
  toolCount: z.number().optional(),
  createdAt: z.number(),
  connected: z.boolean(),
  error: z.string().optional(),
});
export const McpServerList = z.object({ servers: z.array(McpServer) });
export const McpServerAddRequest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1).max(60).optional(),
  transport: McpTransport,
});
export const McpServerResponse = z.object({ server: McpServer });

/** Service keys in the vault's system namespace, set from the CLI over the admin socket. */
export const SERVICE_KEYS = {
  "executor.token": "Executor personal access token",
  "keenable.key": "Keenable API key",
  "bark.deviceKey": "Bark device key (from the Bark app)",
  "assemblyai.key": "AssemblyAI API key (dictation, read aloud, calls)",
} as const;
export type ServiceKey = keyof typeof SERVICE_KEYS;
export const ServiceKeyList = z.object({
  keys: z.array(z.object({ key: z.string(), label: z.string(), set: z.boolean() })),
});
export const ServiceKeySetRequest = z.object({ value: z.string().min(1).max(4000) });

// ── memory (section 13) ──────────────────────────────────────────────────────────────────────

export const MemoryRecallQuery = z.object({ q: z.string().trim().min(1).max(500) });
export const MemoryRecallResponse = z.object({ answer: z.string() });
export type MemoryRecallResponse = z.infer<typeof MemoryRecallResponse>;
export const MemoryStatus = z.object({
  available: z.boolean(),
  /** Honcho was set up and Poke holds its admin token. */
  deployed: z.boolean(),
  chatModel: z.string().nullable(),
  embeddingsModel: z.string().nullable(),
  /** Where the model gateway listens, if it does. */
  gateway: z.string().nullable(),
});
export type MemoryStatus = z.infer<typeof MemoryStatus>;

// ── routines & skills (milestone 8) ─────────────────────────────────────────────────────────────

/** A routine as the app lists it: with its schedule in words. */
export const RoutineView = Routine.extend({ scheduleText: z.string() });
export type RoutineView = z.infer<typeof RoutineView>;
export const RoutineList = z.object({ routines: z.array(RoutineView) });
export const RoutineDetail = z.object({ routine: RoutineView, runs: z.array(RoutineRun) });
export const RoutineSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().min(1) }),
  z.object({ kind: z.literal("cron"), expr: z.string().min(1), tz: z.string().optional() }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(5),
    startAt: z.string().optional(),
  }),
]);
export const RoutinePatchRequest = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  schedule: RoutineSchedule.optional(),
  until: z.string().optional(),
  count: z.number().int().min(1).optional(),
  deliver: z.enum(["always", "only_if_notable"]).optional(),
  enabled: z.boolean().optional(),
});
export type RoutinePatchRequest = z.infer<typeof RoutinePatchRequest>;
export const RoutineRunResponse = z.object({ run: RoutineRun });

export const SkillList = z.object({ skills: z.array(Skill) });
export const SkillDetail = z.object({ skill: Skill.extend({ body: z.string().optional() }) });
export const SkillPatchRequest = z.object({ enabled: z.boolean() });
export const NotificationTestResponse = z.object({ ok: z.literal(true) });

// ── Integrations from the app (milestone 9) ──────────────────────────────────────────────────

export const IntegrationConnectResponse = z.object({ url: z.string() });
export const IntegrationPatchRequest = z
  .object({
    defaultAccountId: z.string().min(1).max(120).optional(),
    capability: z.object({ id: z.string().min(1).max(80), mode: z.enum(["on", "off"]) }).optional(),
  })
  .refine((b) => b.defaultAccountId !== undefined || b.capability !== undefined, "Nothing to change");
export type IntegrationPatchRequest = z.infer<typeof IntegrationPatchRequest>;
export const IntegrationResponse = z.object({ integration: Integration });

export type IntegrationAccount = z.infer<typeof IntegrationAccount>;
export type Integration = z.infer<typeof Integration>;
export type CatalogApp = z.infer<typeof CatalogApp>;
export type McpServer = z.infer<typeof McpServer>;

// ── Voice (section 17, milestone 10) ─────────────────────────────────────────────────────────

export const VoiceOption = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string().optional(),
  description: z.string().optional(),
});
export type VoiceOption = z.infer<typeof VoiceOption>;
/** GET /v1/voice: whether voice is set up, the chosen voice and the ones to pick from. */
export const VoiceInfo = z.object({
  configured: z.boolean(),
  voice: z.string(),
  voices: z.array(VoiceOption),
  /** Mic audio the server expects: mono PCM16 little-endian. */
  inputSampleRate: z.number(),
  /** Call audio the server sends: mono PCM16 little-endian. */
  outputSampleRate: z.number(),
});
export type VoiceInfo = z.infer<typeof VoiceInfo>;
/** POST /v1/tts: a message read aloud, as WAV (cached per message and voice). */
export const TtsRequest = z.object({
  messageId: z.string().min(1),
  voice: z.string().min(1).max(80).optional(),
});
export type TtsRequest = z.infer<typeof TtsRequest>;

/**
 * WS /v1/voice/dictate: the phone sends binary mic audio and `{type:"stop"}`; the server sends
 * the text so far and each finished stretch, then `done` once the last words are in.
 */
export const DictateServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("partial"), text: z.string() }),
  z.object({ type: z.literal("final"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done") }),
]);
export type DictateServerFrame = z.infer<typeof DictateServerFrame>;
export const DictateClientFrame = z.object({ type: z.literal("stop") });

/**
 * WS /v1/voice/call: binary frames both ways are mono PCM16 audio (mic in at 16 kHz, Poke's voice
 * out at `outputSampleRate`); everything else is JSON.
 */
export const CallClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mute"), muted: z.boolean() }),
  /** A camera still (base64 JPEG, at most about 2 MB); the newest goes with his next turn. */
  z.object({ type: z.literal("frame"), jpeg: z.string().max(3_000_000) }),
  z.object({ type: z.literal("camera"), on: z.boolean() }),
  z.object({ type: z.literal("end") }),
]);
export type CallClientFrame = z.infer<typeof CallClientFrame>;
export const CallServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sampleRate: z.number() }),
  z.object({ type: z.literal("state"), state: z.enum(["listening", "thinking", "speaking"]) }),
  z.object({ type: z.literal("user"), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal("poke"), text: z.string(), final: z.boolean() }),
  /** Barge-in: drop the audio still queued for playback. */
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("ended") }),
]);
export type CallServerFrame = z.infer<typeof CallServerFrame>;
