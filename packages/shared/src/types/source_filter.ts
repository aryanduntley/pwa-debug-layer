/**
 * Source-side FilterSpec compiler — the half of FilterSpec that can be applied
 * at the capture chokepoint (extension SW) BEFORE the host assigns sequence
 * numbers. Handles `level` + `pattern` only; cursors (since/until) and limit
 * are seq-based and meaningful only on the host where seqs are assigned, so
 * they are intentionally ignored here.
 *
 * Both extension and host consume this. captures_query.compileTailFilter
 * composes this predicate with its own cursor/limit logic to keep level+pattern
 * semantics in one place — the source-side gate and the host-side tail use the
 * same predicate code path.
 */
import type { ConsoleLevel } from './captured_event.js';
import type { FilterSpec } from './filter_spec.js';

export type SourceFilterError = {
  readonly kind: 'pattern_invalid';
  readonly fieldPath: string;
  readonly error: string;
};

export type SourceFilterPredicate = (event: unknown) => boolean;

export type SourceFilterCompileResult =
  | { readonly ok: true; readonly predicate: SourceFilterPredicate }
  | { readonly ok: false; readonly error: SourceFilterError };

type PatternListResult =
  | { readonly ok: true; readonly value: readonly RegExp[] }
  | { readonly ok: false; readonly error: SourceFilterError };

const compilePatternList = (
  sources: readonly string[] | undefined,
  fieldPathPrefix: string,
): PatternListResult => {
  if (sources === undefined || sources.length === 0) {
    return { ok: true, value: [] };
  }
  const out: RegExp[] = [];
  let i = 0;
  for (const src of sources) {
    try {
      out.push(new RegExp(src));
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'pattern_invalid',
          fieldPath: `${fieldPathPrefix}[${i}]`,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
    i++;
  }
  return { ok: true, value: out };
};

const eventTextForPattern = (event: unknown): string => {
  try {
    return JSON.stringify(event) ?? '';
  } catch {
    return '';
  }
};

export const compileSourceFilter = (
  spec: FilterSpec | undefined,
): SourceFilterCompileResult => {
  const includeResult = compilePatternList(
    spec?.pattern?.include,
    'pattern.include',
  );
  if (!includeResult.ok) return { ok: false, error: includeResult.error };
  const excludeResult = compilePatternList(
    spec?.pattern?.exclude,
    'pattern.exclude',
  );
  if (!excludeResult.ok) return { ok: false, error: excludeResult.error };

  const include = includeResult.value;
  const exclude = excludeResult.value;
  const levelSet =
    spec?.level !== undefined && spec.level.length > 0
      ? new Set<ConsoleLevel>(spec.level)
      : null;

  const predicate: SourceFilterPredicate = (event) => {
    if (levelSet !== null) {
      const lvl = (event as { readonly level?: ConsoleLevel }).level;
      if (lvl === undefined || !levelSet.has(lvl)) return false;
    }
    if (include.length === 0 && exclude.length === 0) return true;
    const text = eventTextForPattern(event);
    for (const re of exclude) {
      if (re.test(text)) return false;
    }
    if (include.length > 0) {
      let any = false;
      for (const re of include) {
        if (re.test(text)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    return true;
  };

  return { ok: true, predicate };
};
