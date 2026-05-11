import { DeepChild } from './DeepChild.js';

export const NestedSection = (): JSX.Element => (
  <section>
    <h2>nested-section</h2>
    <DeepChild />
  </section>
);

NestedSection.displayName = 'NestedSection';
