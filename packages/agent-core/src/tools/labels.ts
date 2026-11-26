import type { AppRef } from "@poke/domain";

export interface ToolLabel {
  /** Past tense for a finished step ("Searched the web"). */
  done: string;
  /** Present tense for the live Trace line ("Searching the web"). */
  live: string;
  app?: AppRef;
}

const TERMINAL: AppRef = { id: "terminal", name: "Terminal", icon: "terminal" };
const FILES: AppRef = { id: "files", name: "Files", icon: "files" };
const WEB: AppRef = { id: "web", name: "Web", icon: "web" };
const BROWSER: AppRef = { id: "browser", name: "Your browser", icon: "browser" };

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function basename(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  return path.split(/[\\/]/).filter(Boolean).pop();
}

function arg(args: unknown, key: string): unknown {
  return args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
}

/**
 * Human labels and app badges for tool calls, as the Trace shows them. Integration tools get
 * their app from Executor's metadata (passed in as `app`).
 */
export function toolLabel(name: string, args: unknown, app?: AppRef): ToolLabel {
  switch (name) {
    case "bash": {
      const command = arg(args, "command");
      return {
        done: "Ran a command",
        live: typeof command === "string" ? `Running ${clip(command, 48)}` : "Running a command",
        app: TERMINAL,
      };
    }
    case "read": {
      const file = basename(arg(args, "path"));
      return {
        done: file ? `Read ${file}` : "Read a file",
        live: file ? `Reading ${file}` : "Reading a file",
        app: FILES,
      };
    }
    case "write": {
      const file = basename(arg(args, "path"));
      return {
        done: file ? `Wrote ${file}` : "Wrote a file",
        live: file ? `Writing ${file}` : "Writing a file",
        app: FILES,
      };
    }
    case "edit": {
      const file = basename(arg(args, "path"));
      return {
        done: file ? `Edited ${file}` : "Edited a file",
        live: file ? `Editing ${file}` : "Editing a file",
        app: FILES,
      };
    }
    case "codemode":
      return { done: "Ran a script", live: "Running a script", app: TERMINAL };
    case "search_web": {
      const query = arg(args, "query");
      return {
        done: "Searched the web",
        live: typeof query === "string" ? `Searching for ${clip(query, 48)}` : "Searching the web",
        app: WEB,
      };
    }
    case "fetch_pages":
      return { done: "Read web pages", live: "Reading web pages", app: WEB };
    case "recall":
      return { done: "Checked what I know", live: "Checking what I know" };
    case "remember":
      return { done: "Remembered that", live: "Remembering" };
    case "search_thread":
      return { done: "Searched the chat", live: "Searching the chat" };
    case "ask_poke":
      return { done: "Asked a question", live: "Waiting for an answer" };
    case "tool_search":
      return { done: "Looked for a tool", live: "Looking for a tool" };
    case "vault_list":
      return { done: "Checked saved logins", live: "Checking saved logins" };
    case "executor_search":
    case "executor_describe":
    case "executor_skills":
      return { done: "Looked through your apps", live: "Looking through your apps" };
    case "executor_call": {
      const calls = arg(args, "calls");
      const first = Array.isArray(calls) ? (calls[0] as unknown) : calls;
      const path = arg(first, "path");
      const appId = typeof path === "string" ? path.replace(/^tools\./, "").split(".")[0] : undefined;
      const appRef = app ?? (appId ? { id: appId, name: titleCase(appId), icon: appId } : undefined);
      return appRef
        ? { done: `Used ${appRef.name}`, live: `Using ${appRef.name}`, app: appRef }
        : { done: "Used your apps", live: "Using your apps" };
    }
    case "executor_execute":
    case "executor_resume":
      return { done: "Used your apps", live: "Using your apps", ...(app ? { app } : {}) };
    case "add_mcp_server":
      return { done: "Added a tool server", live: "Adding a tool server" };
    default:
      break;
  }
  if (name.startsWith("browse_") || name.startsWith("mcp__browse__")) {
    return { done: "Used your browser", live: "Using your browser", app: BROWSER };
  }
  if (app) return { done: `Used ${app.name}`, live: `Using ${app.name}`, app };
  const readable = name.replace(/^mcp__[^_]+__/, "").replace(/[_-]+/g, " ");
  return { done: `Used ${readable}`, live: `Using ${readable}` };
}

function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
