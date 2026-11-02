/**
 * Animation freeze for stable measurements: the one DOM write the layout
 * sweep makes. A single style tag zeroes animation and transition timing so
 * a view settles at its end state; removing it restores the page.
 */
export const FREEZE_STYLE_ID = '__pdl_layout_freeze';

const FREEZE_CSS =
  '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
  'transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';

/** Install the freeze style (idempotent). Returns true when it is in place. */
export const freezeAnimations = (doc: Document): boolean => {
  if (doc.getElementById(FREEZE_STYLE_ID) !== null) return true;
  const parent = doc.head ?? doc.documentElement;
  if (parent === null) return false;
  const style = doc.createElement('style');
  style.id = FREEZE_STYLE_ID;
  style.textContent = FREEZE_CSS;
  parent.appendChild(style);
  return true;
};

/** Remove the freeze style if present. Returns true when one was removed. */
export const unfreezeAnimations = (doc: Document): boolean => {
  const el = doc.getElementById(FREEZE_STYLE_ID);
  if (el === null) return false;
  el.remove();
  return true;
};
