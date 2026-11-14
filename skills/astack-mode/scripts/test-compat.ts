import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

export { describe, it, test };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, idx) => matchesSubset(actual[idx], item));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([k, v]) => k in actual && matchesSubset(actual[k], v));
  }
  return false;
}

function makeMatchers(actual: unknown, negated = false) {
  const check = (pass: boolean, message: string) => {
    if (negated ? pass : !pass) {
      assert.fail(message);
    }
  };

  return {
    get not() {
      return makeMatchers(actual, !negated);
    },
    toBe(expected: unknown) {
      if (negated) assert.notStrictEqual(actual, expected);
      else assert.strictEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      if (negated) assert.notDeepStrictEqual(actual, expected);
      else assert.deepStrictEqual(actual, expected);
    },
    toMatchObject(expected: Record<string, unknown>) {
      const ok = matchesSubset(actual, expected);
      check(ok, `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to match object ${JSON.stringify(expected)}`);
    },
    toContain(item: unknown) {
      const ok =
        typeof actual === "string"
          ? actual.includes(String(item))
          : Array.isArray(actual)
            ? actual.includes(item)
            : false;
      check(ok, `Expected ${JSON.stringify(actual)} ${negated ? "not " : ""}to contain ${JSON.stringify(item)}`);
    },
    toHaveLength(expectedLength: number) {
      const len = (actual as { length?: number })?.length;
      if (negated) assert.notStrictEqual(len, expectedLength);
      else assert.strictEqual(len, expectedLength);
    },
    toBeNull() {
      if (negated) assert.notStrictEqual(actual, null);
      else assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      if (negated) assert.notStrictEqual(actual, undefined);
      else assert.strictEqual(actual, undefined);
    },
    toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown) {
      const ok = actual instanceof ctor;
      check(ok, `Expected value ${negated ? "not " : ""}to be instance of ${ctor.name}`);
    },
    toThrow(expected?: string | RegExp) {
      const fn = actual as () => unknown;
      let threw: unknown = null;
      let didThrow = false;
      try {
        fn();
      } catch (err) {
        didThrow = true;
        threw = err;
      }
      check(didThrow, `Expected function ${negated ? "not " : ""}to throw`);
      if (didThrow && !negated && expected !== undefined) {
        if (typeof expected === "function") {
          assert.ok(threw instanceof expected);
        } else {
          const msg = threw instanceof Error ? threw.message : String(threw);
          if (typeof expected === "string") assert.ok(msg.includes(expected));
          else assert.match(msg, expected);
        }
      }
    },
    rejects: {
      async toThrow(expected?: string | RegExp) {
        const promise = actual as Promise<unknown>;
        await assert.rejects(promise, (err: unknown) => {
          if (expected === undefined) return true;
          const msg = err instanceof Error ? err.message : String(err);
          return typeof expected === "string" ? msg.includes(expected) : expected.test(msg);
        });
      },
      async toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown) {
        const promise = actual as Promise<unknown>;
        await assert.rejects(promise, (err: unknown) => err instanceof ctor);
      },
    },
  };
}

export function expect(actual: unknown) {
  return makeMatchers(actual, false);
}
