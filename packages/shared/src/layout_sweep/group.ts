import type {
  LayoutCheckId,
  LayoutGroup,
  LayoutSummary,
  LocatedFinding,
} from './types.js';

/**
 * Signature used for grouping: digit runs become '#' and whitespace collapses,
 * so "card-12 \"Item 3\"" and "card-7 \"Item 4\"" are the same problem.
 */
export const normalizeSignature = (signature: string): string =>
  signature.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

export const groupKey = (f: { readonly check: LayoutCheckId; readonly signature: string }): string =>
  `${f.check}|${normalizeSignature(f.signature)}`;

type Acc = {
  readonly first: LocatedFinding;
  readonly count: number;
  readonly pages: readonly string[];
  readonly where: readonly string[];
};

const addTo = (acc: Acc | undefined, f: LocatedFinding, whereCap: number): Acc => {
  if (acc === undefined) return { first: f, count: 1, pages: [f.page], where: [f.where] };
  return {
    first: acc.first,
    count: acc.count + 1,
    pages: acc.pages.includes(f.page) ? acc.pages : [...acc.pages, f.page],
    where:
      acc.where.length < whereCap && !acc.where.includes(f.where)
        ? [...acc.where, f.where]
        : acc.where,
  };
};

const toGroup = (a: Acc): LayoutGroup => ({
  check: a.first.check,
  signature: normalizeSignature(a.first.signature),
  message: a.first.message,
  count: a.count,
  pages: a.pages,
  where: a.where,
  ...(a.first.rect !== undefined ? { rect: a.first.rect } : {}),
});

/**
 * Collapse located findings into distinct problems keyed by check + normalized
 * element signature. Most frequent first; ties by check then signature, so the
 * order is stable. The first occurrence supplies the message and rect.
 */
export const groupFindings = (
  findings: readonly LocatedFinding[],
  opts: { readonly whereCap?: number } = {},
): readonly LayoutGroup[] => {
  const whereCap = opts.whereCap ?? 5;
  const byKey = findings.reduce(
    (m, f) => {
      const k = groupKey(f);
      return m.set(k, addTo(m.get(k), f, whereCap));
    },
    new Map<string, Acc>(),
  );
  return [...byKey.values()]
    .map(toGroup)
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.check.localeCompare(b.check) ||
        a.signature.localeCompare(b.signature),
    );
};

/** Totals for the result header: raw problems, distinct groups, raw count per check. */
export const summarizeFindings = (
  findings: readonly LocatedFinding[],
  groups: readonly LayoutGroup[],
): LayoutSummary => ({
  problems: findings.length,
  groups: groups.length,
  by_check: findings.reduce<Partial<Record<LayoutCheckId, number>>>(
    (acc, f) => ({ ...acc, [f.check]: (acc[f.check] ?? 0) + 1 }),
    {},
  ),
});

/** Keep the first `cap` groups inline; report how many were left for the report file. */
export const capGroups = (
  groups: readonly LayoutGroup[],
  cap = 50,
): { readonly groups: readonly LayoutGroup[]; readonly omitted: number } => ({
  groups: groups.slice(0, cap),
  omitted: Math.max(0, groups.length - cap),
});
