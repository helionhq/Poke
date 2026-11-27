import { describe, expect, it } from "vitest";
import { argsHash } from "./approvals.js";
import { evaluateLogic, isLogic } from "./logic.js";

describe("always-allow conditions", () => {
  const under100 = { "<": [{ var: "amount" }, 100] };

  it("evaluates comparisons, paths and combinations over the arguments", () => {
    expect(evaluateLogic(under100, { amount: 84 })).toBe(true);
    expect(evaluateLogic(under100, { amount: 100 })).toBe(false);
    expect(evaluateLogic(under100, { amount: "84" })).toBe(false); // no coercion
    expect(evaluateLogic(under100, {})).toBe(false);
    const rule = {
      and: [
        { "<=": [{ var: "refund.amount" }, 50] },
        { in: [{ var: "refund.currency" }, ["USD", "EUR"]] },
        { "!": [{ "==": [{ var: "refund.reason" }, "fraud"] }] },
      ],
    };
    expect(evaluateLogic(rule, { refund: { amount: 50, currency: "EUR", reason: "damaged" } })).toBe(true);
    expect(evaluateLogic(rule, { refund: { amount: 50, currency: "GBP", reason: "damaged" } })).toBe(false);
    expect(
      evaluateLogic(
        { or: [false, { "==": [{ var: "to" }, "maya@northwind.co"] }] },
        { to: "maya@northwind.co" },
      ),
    ).toBe(true);
    expect(evaluateLogic({ in: ["@northwind.co", { var: "to" }] }, { to: "maya@northwind.co" })).toBe(true);
  });

  it("refuses what it can't read", () => {
    expect(isLogic(under100)).toBe(true);
    expect(isLogic({ "<": [1, 2], ">": [2, 1] })).toBe(false);
    expect(isLogic({ eval: "process.exit()" })).toBe(false);
    expect(() => evaluateLogic({ eval: "x" }, {})).toThrow(/unknown operator/);
    expect(evaluateLogic({ "==": [{ var: "constructor" }, undefined] }, {})).toBe(true); // own keys only
  });

  it("hashes arguments the same whatever the key order", () => {
    expect(argsHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(argsHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });
});
