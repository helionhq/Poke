import { z } from "zod";
import { defineToolSpec } from "./define.js";

// ── Web (Keenable) ───────────────────────────────────────────────────────────────────────────

export const searchWeb = defineToolSpec({
  name: "search_web",
  description:
    "Search the web. Describe the page you want in plain words; results come back numbered with their text, so cite them.",
  input: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).optional(),
    site: z.string().max(200).optional().describe("Only this domain, e.g. arxiv.org"),
    publishedAfter: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
      .optional(),
    mode: z.enum(["pro", "realtime"]).optional().describe("realtime is faster, pro digs deeper (default)"),
  }),
  replay: "safe",
  searchHint: "web search internet google",
});

export const fetchPages = defineToolSpec({
  name: "fetch_pages",
  description: "Read web pages as clean text. Pass a prompt to get only the answer to it from each page.",
  input: z.object({
    urls: z.array(z.string().url()).min(1).max(20),
    maxChars: z.number().int().min(500).max(100_000).optional().describe("Most characters per page"),
    prompt: z.string().max(2000).optional(),
  }),
  replay: "safe",
  searchHint: "read web page url fetch",
});

// ── Vault ────────────────────────────────────────────────────────────────────────────────────

export const vaultList = defineToolSpec({
  name: "vault_list",
  description:
    "List saved logins, keys and codes (names and non-secret fields only) and the {{vault:…}} placeholders that use them.",
  input: z.object({ query: z.string().max(100).optional() }),
  replay: "safe",
  searchHint: "password login secret key credentials",
});

// ── Executor Cloud (integrations) ────────────────────────────────────────────────────────────

const intent = z
  .string()
  .max(200)
  .optional()
  .describe(
    "What this does, in plain words, for the OK Arham may be asked for: 'Refund $84.00 to Maya Chen', 'Send the refund email to Maya'",
  );

export const executorSkills = defineToolSpec({
  name: "executor_skills",
  description: "Executor: list the connected apps' skills, or read one (app + name) before using an app.",
  input: z.object({
    app: z.string().max(120).optional(),
    name: z.string().max(120).optional(),
    file: z.string().max(300).optional(),
  }),
  callers: ["model"],
  replay: "safe",
});

export const executorSearch = defineToolSpec({
  name: "executor_search",
  description:
    "Executor: find tools across Arham's connected apps (Gmail, Calendar, GitHub, Stripe…) by what they do.",
  input: z.object({
    query: z.string().max(300).optional(),
    namespace: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  callers: ["model"],
  replay: "safe",
});

export const executorDescribe = defineToolSpec({
  name: "executor_describe",
  description:
    "Executor: the full signature and description of tools, by the paths executor_search returned.",
  input: z.object({ paths: z.array(z.string().min(1)).min(1).max(20) }),
  callers: ["model"],
  replay: "safe",
});

export const executorCall = defineToolSpec({
  name: "executor_call",
  description:
    "Executor: call one or more app tools by path with their input. Some calls wait for Arham's OK; that happens by itself.",
  input: z.object({
    calls: z.union([
      z.object({ path: z.string().min(1), input: z.unknown() }),
      z
        .array(z.object({ path: z.string().min(1), input: z.unknown() }))
        .min(1)
        .max(20),
    ]),
    intent,
  }),
  callers: ["model"],
});

export const executorExecute = defineToolSpec({
  name: "executor_execute",
  description:
    "Executor: run a short JavaScript program that calls app tools as `await tools.<path>(input)` and returns a value. For loops, batches and joining results.",
  input: z.object({ code: z.string().min(1).max(65_536), intent }),
  callers: ["model"],
});

export const executorResume = defineToolSpec({
  name: "executor_resume",
  description:
    "Executor: answer a call that stopped to ask for input (an `input-required` request). Approvals aren't answered here.",
  input: z.object({
    requestId: z.string().regex(/^elc_/, "only input requests (elc_…) are answered here"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
  callers: ["model"],
});

// ── Local MCP servers ────────────────────────────────────────────────────────────────────────

export const addMcpServer = defineToolSpec({
  name: "add_mcp_server",
  description:
    "Add an MCP server Arham asked for, by URL (streamable HTTP) or by command (stdio). Its tools reach agents started after it.",
  input: z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes")
        .describe("Short id, e.g. linear"),
      url: z.string().url().optional(),
      command: z.string().max(300).optional(),
      args: z.array(z.string().max(500)).max(30).optional(),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("For secrets use {{vault:name.field}} placeholders, never values"),
      env: z.record(z.string(), z.string()).optional().describe("Same: placeholders only"),
    })
    .refine((v) => Boolean(v.url) !== Boolean(v.command), "give either url or command"),
});

export const INTEGRATION_TOOLS = {
  searchWeb,
  fetchPages,
  vaultList,
  executorSkills,
  executorSearch,
  executorDescribe,
  executorCall,
  executorExecute,
  executorResume,
  addMcpServer,
};
