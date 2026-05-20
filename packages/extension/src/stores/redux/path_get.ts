/**
 * JSONPath-lite getter: walk a value by a dot+bracket path with deterministic
 * error reporting. Used by `redux.get_state` (and forthcoming `redux.subscribe`)
 * to let AI clients drill into a single slice instead of dumping the whole
 * store tree.
 *
 * Grammar:
 *   path        := token ('.' token | bracket)*
 *   token       := /[A-Za-z_$][A-Za-z0-9_$]+/
 *   bracket     := '[' (integer | quotedString) ']'
 *   quotedString:= "'" any-but-quote* "'" | '"' any-but-quote* '"'
 *
 * Semantics:
 *   - undefined or empty path => identity (returns root unchanged).
 *   - bracket-integer = numeric index (non-negative); out-of-range => ok:true
 *     with value=undefined (mirrors JS access).
 *   - bracket-string = property name; allows symbols not legal as bare tokens.
 *   - descent into a primitive (string/number/bool/null/undefined) at any
 *     intermediate step => ok:false with informative error.
 *
 * Pure. No regex over the input on every getValueAtPath call past the
 * single tokenize pass.
 */

export type PathGetResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

type Step =
  | { readonly kind: 'name'; readonly key: string }
  | { readonly kind: 'index'; readonly idx: number };

const NAME_CHAR = /^[A-Za-z0-9_$]$/;
const NAME_START = /^[A-Za-z_$]$/;

type TokenizeResult =
  | { readonly ok: true; readonly steps: readonly Step[] }
  | { readonly ok: false; readonly error: string };

const tokenize = (path: string): TokenizeResult => {
  const steps: Step[] = [];
  const len = path.length;
  let i = 0;
  let expectingName = true;
  while (i < len) {
    const c = path.charAt(i);
    if (c === '.') {
      if (expectingName) {
        return { ok: false, error: `unexpected '.' at position ${i}` };
      }
      expectingName = true;
      i++;
      continue;
    }
    if (c === '[') {
      const end = path.indexOf(']', i + 1);
      if (end === -1) {
        return { ok: false, error: `unclosed '[' at position ${i}` };
      }
      const inner = path.slice(i + 1, end);
      if (inner.length === 0) {
        return { ok: false, error: `empty bracket at position ${i}` };
      }
      if (
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
      ) {
        steps.push({ kind: 'name', key: inner.slice(1, -1) });
      } else if (/^\d+$/.test(inner)) {
        steps.push({ kind: 'index', idx: Number.parseInt(inner, 10) });
      } else {
        return {
          ok: false,
          error: `invalid bracket content "${inner}" at position ${i}`,
        };
      }
      expectingName = false;
      i = end + 1;
      continue;
    }
    if (expectingName) {
      if (!NAME_START.test(c)) {
        return {
          ok: false,
          error: `unexpected '${c}' at position ${i}; expected name start`,
        };
      }
      let j = i + 1;
      while (j < len && NAME_CHAR.test(path.charAt(j))) j++;
      steps.push({ kind: 'name', key: path.slice(i, j) });
      expectingName = false;
      i = j;
      continue;
    }
    return { ok: false, error: `unexpected '${c}' at position ${i}` };
  }
  if (expectingName && steps.length === 0) {
    return { ok: true, steps: [] };
  }
  if (expectingName) {
    return { ok: false, error: `path ends with trailing '.'` };
  }
  return { ok: true, steps };
};

const isContainer = (v: unknown): boolean =>
  v !== null && (typeof v === 'object' || typeof v === 'function');

export const getValueAtPath = (
  root: unknown,
  path?: string,
): PathGetResult => {
  if (path === undefined || path.length === 0) {
    return { ok: true, value: root };
  }
  const tok = tokenize(path);
  if (!tok.ok) return { ok: false, error: tok.error };
  let cur: unknown = root;
  for (let i = 0; i < tok.steps.length; i++) {
    const step = tok.steps[i] as Step;
    if (!isContainer(cur)) {
      return {
        ok: false,
        error: `cannot descend into ${typeof cur === 'object' ? 'null' : typeof cur} at step ${i}`,
      };
    }
    if (step.kind === 'index') {
      cur = (cur as readonly unknown[])[step.idx];
    } else {
      cur = (cur as Record<string, unknown>)[step.key];
    }
  }
  return { ok: true, value: cur };
};
