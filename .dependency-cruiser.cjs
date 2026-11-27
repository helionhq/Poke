/**
 * Clean-architecture dependency rules for the Poke monorepo.
 * domain → nothing; application → domain/contracts/blocks/agent-core; adapters implement ports;
 * apps are composition roots. Run with `pnpm boundaries`.
 */
const P = "^packages/";
const ADAPTERS = "^packages/adapters/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "packages/domain imports nothing: no other package, no npm module, no node builtin.",
      severity: "error",
      from: { path: `${P}domain/src` },
      to: { pathNot: [`${P}domain/src`] },
    },
    {
      name: "blocks-only-zod",
      severity: "error",
      from: { path: `${P}blocks/src` },
      to: { pathNot: [`${P}blocks/src`, "node_modules/zod/", "node_modules/.pnpm/zod@"] },
    },
    {
      name: "contracts-only-blocks-and-zod",
      severity: "error",
      from: { path: `${P}contracts/src` },
      to: { pathNot: [`${P}contracts/src`, `${P}blocks/src`, String.raw`node_modules/(\.pnpm/)?zod`] },
    },
    {
      name: "agent-core-inner-only",
      severity: "error",
      from: { path: `${P}agent-core/src` },
      to: {
        path: ["^packages/(application|client|ui-native|ui-tokens|adapters)/", "^apps/"],
      },
    },
    {
      name: "application-inner-only",
      comment:
        "application depends on domain, contracts, blocks and agent-core only (plus small pure npm libs).",
      severity: "error",
      from: { path: `${P}application/src` },
      to: { path: ["^packages/(client|ui-native|ui-tokens|adapters)/", "^apps/"] },
    },
    {
      name: "adapters-never-import-application-or-apps",
      severity: "error",
      from: { path: ADAPTERS },
      to: { path: [`${P}application/`, "^apps/", `${P}(client|ui-native|ui-tokens)/`] },
    },
    {
      name: "adapters-are-independent",
      comment: "Adapters don't import each other, except the MCP bridge (shared by browse and Executor).",
      severity: "error",
      from: { path: `${ADAPTERS}([^/]+)/` },
      to: { path: ADAPTERS, pathNot: [`${ADAPTERS}$1/`, `${ADAPTERS}mcp-bridge/`] },
    },
    {
      name: "client-is-thin",
      severity: "error",
      from: { path: `${P}client/src` },
      to: { path: [`${P}(domain|application|agent-core|ui-native|adapters)/`, "^apps/"] },
    },
    {
      name: "ui-is-platform-only",
      severity: "error",
      from: { path: `${P}ui-(native|tokens)/src` },
      to: { path: [`${P}(domain|application|agent-core|adapters)/`, "^apps/"] },
    },
    {
      name: "packages-never-import-apps",
      severity: "error",
      from: { path: P },
      to: { path: "^apps/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: ["dist/", String.raw`\.test\.tsx?$`, "/test/"] },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@poke/source", "import", "types", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    tsConfig: { fileName: "tsconfig.depcruise.json" },
  },
};
