#!/usr/bin/env node
import { startServer } from "./server.js";

const server = await startServer();

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  server.services.log.info({ signal }, "poke-server stopping");
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
