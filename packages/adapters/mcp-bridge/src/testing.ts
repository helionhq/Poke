import { fileURLToPath } from "node:url";

/** A stdio MCP server for tests; `FAKE_MODE=executor` answers like Executor in model mode. */
export const FAKE_MCP_SERVER = fileURLToPath(new URL("./fixtures/fake-server.mjs", import.meta.url));
