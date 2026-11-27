/**
 * A small JSON-logic subset for always-allow conditions over a call's arguments, e.g.
 * `{"<": [{"var": "amount"}, 100]}` for "refunds under $100". Operators: var (dot paths), ==,
 * !=, <, <=, >, >=, and, or, !, in. Anything else throws, and a rule that throws never allows.
 */

const OPERATORS = new Set(["var", "==", "!=", "<", "<=", ">", ">=", "and", "or", "!", "in"]);
const MAX_DEPTH = 12;

export function isLogic(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every((item) => isLogic(item, depth + 1));
  if (typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !OPERATORS.has(keys[0]!)) return false;
  return isLogic((value as Record<string, unknown>)[keys[0]!], depth + 1);
}

export function evaluateLogic(logic: unknown, data: Record<string, unknown>, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error("condition too deep");
  if (logic === null || typeof logic !== "object") return logic;
  if (Array.isArray(logic)) return logic.map((item) => evaluateLogic(item, data, depth + 1));
  const [op, ...rest] = Object.keys(logic);
  if (!op || rest.length > 0) throw new Error("one operator per object");
  const raw = (logic as Record<string, unknown>)[op];
  const args = Array.isArray(raw) ? raw : [raw];
  const value = (i: number) => evaluateLogic(args[i], data, depth + 1);
  switch (op) {
    case "var":
      return lookup(data, String(value(0) ?? ""));
    case "==":
      return value(0) === value(1);
    case "!=":
      return value(0) !== value(1);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const a = value(0);
      const b = value(1);
      if (typeof a !== "number" || typeof b !== "number") return false;
      return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
    }
    case "and":
      return args.every((_, i) => value(i) === true);
    case "or":
      return args.some((_, i) => value(i) === true);
    case "!":
      return value(0) !== true;
    case "in": {
      const needle = value(0);
      const haystack = value(1);
      if (Array.isArray(haystack)) return haystack.includes(needle);
      if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
      return false;
    }
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

function lookup(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
