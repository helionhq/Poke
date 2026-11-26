import type { ToolCaller, ToolLoading, ToolSpec } from "@poke/domain";
import { z } from "zod";

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  spec: ToolSpec;
  input: S;
  /** Validate and coerce arguments; throws a readable error for the model. */
  parse(args: unknown): z.infer<S>;
}

export function defineToolSpec<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  input: S;
  loading?: ToolLoading;
  callers?: ToolCaller[];
  replay?: "safe" | "unsafe";
  namespace?: string;
  searchHint?: string;
}): ToolDefinition<S> {
  const inputSchema = z.toJSONSchema(def.input, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
  delete inputSchema.$schema;
  const spec: ToolSpec = {
    name: def.name,
    description: def.description,
    inputSchema,
    loading: def.loading ?? "always",
    callers: def.callers ?? ["model", "tools"],
    replay: def.replay ?? "unsafe",
    ...(def.namespace ? { namespace: def.namespace } : {}),
    ...(def.searchHint ? { searchHint: def.searchHint } : {}),
  };
  return {
    spec,
    input: def.input,
    parse(args) {
      const result = def.input.safeParse(args ?? {});
      if (result.success) return result.data;
      const issue = result.error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      throw new ToolInputError(`${def.name}: ${issue?.message ?? "invalid arguments"}${where}`);
    },
  };
}

export class ToolInputError extends Error {
  override name = "ToolInputError";
}
