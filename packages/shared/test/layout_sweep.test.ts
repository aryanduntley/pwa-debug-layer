import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECKS,
  capGroups,
  crossDimensions,
  expandTemplate,
  groupFindings,
  normalizeSignature,
  pageLabel,
  planPageViews,
  planSweep,
  resolveChecksConfig,
  resolveCustomChecks,
  customCheckId,
  resolvePageUrl,
  summarizeFindings,
  viewVars,
  type LocatedFinding,
} from '../src/index.js';

describe('resolveChecksConfig', () => {
  it('returns the defaults when nothing is given', () => {
    const r = resolveChecksConfig(undefined);
    expect(r).toEqual({ ok: true, config: DEFAULT_CHECKS });
  });

  it('switches checks with booleans and merges partial knobs', () => {
    const r = resolveChecksConfig({ contrast: true, offscreen: false, tap_target: { min: 44 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.contrast.enabled).toBe(true);
    expect(r.config.offscreen.enabled).toBe(false);
    expect(r.config.tap_target).toEqual({ enabled: true, min: 44 });
    expect(r.config.edge_contact).toEqual(DEFAULT_CHECKS.edge_contact);
  });

  it('rejects out-of-range knobs and bad regexes', () => {
    expect(resolveChecksConfig({ tap_target: { min: 0 } }).ok).toBe(false);
    expect(resolveChecksConfig({ edge_contact: { min_inset: 100 } }).ok).toBe(false);
    expect(resolveChecksConfig({ ring_clipped: { min_px: 0 } }).ok).toBe(false);
    expect(resolveChecksConfig({ ring_clipped: { min_px: 2 } })).toMatchObject({ ok: true, config: { ring_clipped: { enabled: true, min_px: 2 } } });
    const bad = resolveChecksConfig({ text_patterns: { extra: ['(unclosed'] } });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining('(unclosed') });
  });
});

const at = (over: Partial<LocatedFinding>): LocatedFinding => ({
  check: 'tap_target',
  signature: 'a.link "Item 1"',
  message: 'tap target 300×21',
  page: 'https://x.test/a.html',
  where: 'a.html@360 light',
  ...over,
});

describe('groupFindings', () => {
  it('normalizes digits and whitespace in signatures', () => {
    expect(normalizeSignature('li.card-12  "Item 3"')).toBe('li.card-# "Item #"');
  });

  it('groups by check + normalized signature, most frequent first', () => {
    const findings = [
      at({}),
      at({ signature: 'a.link "Item 2"', where: 'a.html@390 light' }),
      at({ signature: 'a.link "Item 3"', page: 'https://x.test/b.html', where: 'b.html@360 dark' }),
      at({ check: 'offscreen', signature: 'div.hero', message: 'off screen' }),
    ];
    const groups = groupFindings(findings);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      check: 'tap_target',
      signature: 'a.link "Item #"',
      count: 3,
      pages: ['https://x.test/a.html', 'https://x.test/b.html'],
      where: ['a.html@360 light', 'a.html@390 light', 'b.html@360 dark'],
      message: 'tap target 300×21',
    });
    expect(groups[1]).toMatchObject({ check: 'offscreen', count: 1 });
  });

  it('caps where lists and the inline group list', () => {
    const many = Array.from({ length: 8 }, (_, i) => at({ where: `a.html@${300 + i} light` }));
    expect(groupFindings(many)[0]?.where).toHaveLength(5);
    expect(groupFindings(many, { whereCap: 2 })[0]?.where).toHaveLength(2);
    const groups = groupFindings(
      Array.from({ length: 4 }, (_, i) => at({ check: 'offscreen', signature: `div.x${'y'.repeat(i)}` })),
    );
    expect(capGroups(groups, 3)).toMatchObject({ omitted: 1 });
    expect(capGroups(groups, 3).groups).toHaveLength(3);
  });

  it('summarizes raw counts per check', () => {
    const findings = [at({}), at({}), at({ check: 'offscreen', signature: 'div' })];
    expect(summarizeFindings(findings, groupFindings(findings))).toEqual({
      problems: 3,
      groups: 2,
      by_check: { tap_target: 2, offscreen: 1 },
    });
  });
});

describe('planSweep', () => {
  it('resolves relative pages against base_url and refuses them without one', () => {
    expect(resolvePageUrl('customer/4.01-search.html', 'http://127.0.0.1:8080/pages/')).toBe(
      'http://127.0.0.1:8080/pages/customer/4.01-search.html',
    );
    expect(resolvePageUrl('customer/x.html')).toBeNull();
    expect(resolvePageUrl('javascript:alert(1)')).toBeNull();
    const r = planSweep({ target: 'phone', pages: ['a.html'] });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('base_url') });
  });

  it('starts phones at their own size, launched browsers at the three widths', () => {
    const phone = planSweep({ target: 'phone', pages: ['https://x.test/'] });
    const desk = planSweep({ target: 'launched_browser', pages: ['https://x.test/'] });
    if (!phone.ok || !desk.ok) throw new Error('plan failed');
    expect(phone.plan.viewports.map((v) => v?.width ?? null)).toEqual([null, 360, 390, 430]);
    expect(desk.plan.viewports.map((v) => v?.width)).toEqual([360, 390, 430]);
    expect(desk.plan.viewports[0]).toEqual({ width: 360, height: 800, dpr: 2, mobile: true });
    expect(desk.plan.schemes).toEqual(['light', 'dark']);
    expect(desk.plan.estimated_views).toBe(6);
  });

  it('crosses dimensions and enforces max_views on the estimate', () => {
    expect(crossDimensions({ lang: ['en', 'es'], density: ['a', 'b'] })).toEqual([
      { lang: 'en', density: 'a' },
      { lang: 'en', density: 'b' },
      { lang: 'es', density: 'a' },
      { lang: 'es', density: 'b' },
    ]);
    expect(crossDimensions(undefined)).toEqual([{}]);
    const r = planSweep({
      target: 'launched_browser',
      pages: ['https://x.test/a', 'https://x.test/b'],
      states: { dimensions: { lang: ['en', 'es'] } },
      max_views: 20,
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('24 views') });
  });

  it('rejects reserved or malformed dimension names and bad viewports', () => {
    const reserved = planSweep({
      target: 'phone',
      pages: ['https://x.test/'],
      states: { dimensions: { scheme: ['x'] } },
    });
    expect(reserved.ok).toBe(false);
    const empty = planSweep({ target: 'phone', pages: ['https://x.test/'], states: { dimensions: { lang: [] } } });
    expect(empty.ok).toBe(false);
    const vp = planSweep({ target: 'phone', pages: ['https://x.test/'], viewports: [{ width: 50 }] });
    expect(vp.ok).toBe(false);
    expect(planSweep({ target: 'phone', pages: [] }).ok).toBe(false);
  });
});

describe('planPageViews / labels / templates', () => {
  const plan = (() => {
    const r = planSweep({
      target: 'launched_browser',
      pages: ['https://x.test/pages/4.30-sign-in.html'],
      viewports: [{ width: 360 }, { width: 430 }],
      color_schemes: ['dark'],
      states: { dimensions: { lang: ['en', 'es'] } },
    });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  })();

  it('orders views viewport → scheme → dimensions → state and labels them', () => {
    const views = planPageViews(plan, plan.pages[0] as string, ['', 'create']);
    expect(views).toHaveLength(2 * 1 * 2 * 2);
    expect(views.map((v) => v.label).slice(0, 4)).toEqual([
      '4.30-sign-in.html@360 en/dark',
      '4.30-sign-in.html@360 create/en/dark',
      '4.30-sign-in.html@360 es/dark',
      '4.30-sign-in.html@360 create/es/dark',
    ]);
    expect(views[4]?.viewport?.width).toBe(430);
  });

  it('treats an empty state list as the page as loaded', () => {
    expect(planPageViews(plan, plan.pages[0] as string, [])).toHaveLength(4);
  });

  it('labels native phone views @device and falls back to the host for bare origins', () => {
    const r = planSweep({ target: 'phone', pages: ['https://x.test/'], color_schemes: ['light'] });
    if (!r.ok) throw new Error(r.error);
    expect(planPageViews(r.plan, 'https://x.test/', [])[0]?.label).toBe('x.test@device light');
    expect(pageLabel('not a url')).toBe('not a url');
    expect(pageLabel('data:text/html,<p>hi</p>')).toMatch(/^data:[0-9a-z]+$/);
    expect(pageLabel(`https://x.test/${'a'.repeat(100)}`)).toHaveLength(60);
  });

  it('fills templates from view variables', () => {
    const view = planPageViews(plan, plan.pages[0] as string, ['create'])[0];
    if (view === undefined) throw new Error('no view');
    const vars = viewVars(view, { width: 412, height: 915 });
    expect(vars).toMatchObject({ state: 'create', scheme: 'dark', lang: 'en', width: '360', height: '800' });
    expect(expandTemplate('#state={state}&lang={lang}&theme={scheme}&x={missing}', vars)).toBe(
      '#state=create&lang=en&theme=dark&x={missing}',
    );
    expect(expandTemplate('{state}', { state: 'a b&c' })).toBe('a%20b%26c');
  });
});

describe('resolveCustomChecks', () => {
  it('accepts nothing, and valid checks', () => {
    expect(resolveCustomChecks(undefined)).toEqual({ ok: true, checks: [] });
    expect(resolveCustomChecks([{ name: 'price_wraps', expression: "pdl.elements('.price')" }])).toEqual({
      ok: true,
      checks: [{ name: 'price_wraps', expression: "pdl.elements('.price')" }],
    });
    expect(customCheckId('price_wraps')).toBe('custom:price_wraps');
  });

  it('rejects bad shapes, names, empty or huge expressions, duplicates and too many checks', () => {
    expect(resolveCustomChecks({})).toMatchObject({ ok: false });
    expect(resolveCustomChecks([{ name: 'Bad-Name', expression: '1' }])).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(resolveCustomChecks([{ name: 'ok', expression: '  ' }])).toMatchObject({ ok: false, error: expect.stringContaining('non-empty') });
    expect(resolveCustomChecks([{ name: 'ok', expression: 'x'.repeat(10_001) }])).toMatchObject({ ok: false, error: expect.stringContaining('longer') });
    expect(resolveCustomChecks([{ name: 'a', expression: '1' }, { name: 'a', expression: '2' }])).toEqual({ ok: false, error: 'custom_checks: duplicate name "a"' });
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, expression: '1' }));
    expect(resolveCustomChecks(many)).toMatchObject({ ok: false, error: expect.stringContaining('at most 20') });
  });
});
