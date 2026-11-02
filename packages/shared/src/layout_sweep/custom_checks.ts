import type { CustomCheck } from './types.js';

/** Limits for caller-defined checks (layout_sweep custom_checks). */
export const CUSTOM_CHECK_LIMITS = Object.freeze({
  max_checks: 20,
  max_expression: 10_000,
  /** Findings kept per check per view. */
  max_findings: 100,
});

const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Finding check id for a custom check: custom:<name>. */
export const customCheckId = (name: string): `custom:${string}` => `custom:${name}`;

export type CustomChecksResult =
  | { readonly ok: true; readonly checks: readonly CustomCheck[] }
  | { readonly ok: false; readonly error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate caller checks: an array of { name, expression }, names lowercase
 * snake_case (1-40 chars, starting with a letter) and unique, expressions
 * non-empty and at most max_expression chars, at most max_checks entries.
 * Pure. Whether an expression compiles is only known in the page.
 */
export const resolveCustomChecks = (input: unknown): CustomChecksResult => {
  if (input === undefined) return { ok: true, checks: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'custom_checks must be an array of { name, expression }' };
  if (input.length > CUSTOM_CHECK_LIMITS.max_checks) {
    return { ok: false, error: `custom_checks: at most ${CUSTOM_CHECK_LIMITS.max_checks} checks` };
  }
  const bad = input
    .map((c, i): string | null => {
      if (!isRecord(c)) return `custom_checks[${i}] must be an object { name, expression }`;
      const { name, expression } = c;
      if (typeof name !== 'string' || !NAME.test(name)) {
        return `custom_checks[${i}].name must be lowercase letters, digits and _ (1-40 chars, starting with a letter)`;
      }
      if (typeof expression !== 'string' || expression.trim() === '') {
        return `custom_checks[${i}].expression (${name}) must be a non-empty string`;
      }
      if (expression.length > CUSTOM_CHECK_LIMITS.max_expression) {
        return `custom_checks[${i}].expression (${name}) is longer than ${CUSTOM_CHECK_LIMITS.max_expression} characters`;
      }
      return null;
    })
    .find((e) => e !== null);
  if (bad !== undefined && bad !== null) return { ok: false, error: bad };
  const checks = (input as readonly Record<string, string>[]).map((c) =>
    Object.freeze({ name: c['name'] as string, expression: c['expression'] as string }),
  );
  const names = checks.map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) return { ok: false, error: `custom_checks: duplicate name "${dup}"` };
  return { ok: true, checks: Object.freeze(checks) };
};
