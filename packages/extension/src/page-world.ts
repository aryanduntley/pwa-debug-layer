type FrameworkHookProbe = {
  readonly react: boolean;
  readonly vue: boolean;
  readonly svelte: boolean;
  readonly redux: boolean;
};

const probeGlobals = (): FrameworkHookProbe => {
  const w = window as unknown as Record<string, unknown>;
  return {
    react: '__REACT_DEVTOOLS_GLOBAL_HOOK__' in w,
    vue: '__VUE_DEVTOOLS_GLOBAL_HOOK__' in w,
    svelte: '__svelte' in w,
    redux: '__REDUX_DEVTOOLS_EXTENSION__' in w,
  };
};

const probeDom = (): Pick<FrameworkHookProbe, 'react' | 'vue' | 'svelte'> => {
  let react = false;
  let vue = false;
  let svelte = false;
  const root = document.body ?? document.documentElement;
  if (!root) return { react, vue, svelte };
  const sample: Element[] = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  while (walker.nextNode() && count < 100) {
    sample.push(walker.currentNode as Element);
    count += 1;
  }
  for (const el of sample) {
    if (react && vue && svelte) break;
    const keys = Object.keys(el);
    if (
      !react &&
      keys.some(
        (k) =>
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactContainer$') ||
          k.startsWith('__reactProps$'),
      )
    ) {
      react = true;
    }
    if (
      !vue &&
      ('__vue__' in el ||
        '__vue_app__' in el ||
        keys.some((k) => k === '_vnode' || k.startsWith('__vnode')))
    ) {
      vue = true;
    }
    if (!svelte && keys.some((k) => k.startsWith('__svelte'))) {
      svelte = true;
    }
  }
  return { react, vue, svelte };
};

const merge = (
  early: FrameworkHookProbe,
  dom: Pick<FrameworkHookProbe, 'react' | 'vue' | 'svelte'>,
): FrameworkHookProbe => ({
  react: early.react || dom.react,
  vue: early.vue || dom.vue,
  svelte: early.svelte || dom.svelte,
  redux: early.redux,
});

export const bootstrap = (): void => {
  const early = probeGlobals();
  console.log('[pwa-debug/page] world=MAIN, hooks(early)=', early);

  const reportLate = (): void => {
    const merged = merge(early, probeDom());
    console.log('[pwa-debug/page] hooks(post-load)=', merged);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportLate, { once: true });
  } else {
    setTimeout(reportLate, 0);
  }
};

bootstrap();
