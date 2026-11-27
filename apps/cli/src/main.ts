#!/usr/bin/env node
// Launcher: silence the node:sqlite warning before anything loads it, then start the CLI.
import "./quiet.js";

await import("./cli.js");
