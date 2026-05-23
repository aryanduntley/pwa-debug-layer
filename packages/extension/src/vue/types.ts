/**
 * Vue 3 introspection vocabulary — the subset of Vue's internal runtime shapes
 * this module reads. Parity with react/types.ts, but Vue's model differs:
 *  - There is no per-host-node fiber; only COMPONENT instances are tree nodes.
 *  - A component instance has no `$children`; child instances are discovered by
 *    walking its rendered `subTree` VNode (see collect_child_instances).
 *  - The mount container carries `__vue_app__`; every rendered DOM node carries
 *    `__vueParentComponent` pointing at the instance that rendered it.
 */

/** Property the Vue app sets on its mount container element. */
export const VUE_APP_KEY = '__vue_app__';
/** Property Vue sets on every rendered DOM node → its owning instance. */
export const VUE_PARENT_COMPONENT_KEY = '__vueParentComponent';

/** Minimal VNode shape we read. `children` may be VNode[] | string | slots | null. */
export type VueVNode = {
  readonly type: unknown;
  readonly key: string | number | symbol | null;
  /** Set on a component VNode → the child ComponentInternalInstance it mounts. */
  readonly component: ComponentInternalInstance | null;
  readonly children: unknown;
};

/** The subset of Vue 3's ComponentInternalInstance this module reads. */
export type ComponentInternalInstance = {
  readonly uid: number;
  /** Component definition: options object, <script setup> compiled object, or fn. */
  readonly type: unknown;
  readonly parent: ComponentInternalInstance | null;
  /** The VNode tree this component rendered (null before mount / after unmount). */
  readonly subTree: VueVNode | null;
  /** This component's own placeholder VNode (carries its `key`). */
  readonly vnode: VueVNode | null;
  readonly props?: unknown;
  readonly setupState?: unknown;
  readonly data?: unknown;
  readonly isUnmounted?: boolean;
};

/** Vue app instance attached at `el.__vue_app__`. */
export type VueAppInstance = {
  readonly _instance: ComponentInternalInstance | null;
  /**
   * App-level config. `globalProperties` is where `app.use(pinia)` attaches the
   * active Pinia instance as `$pinia` (Vue 3) — the seam Pinia auto-discovery
   * reads. Optional: only present on real Vue 3 apps.
   */
  readonly config?: {
    readonly globalProperties?: Record<string, unknown>;
  };
};
