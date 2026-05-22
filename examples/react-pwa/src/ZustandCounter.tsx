import { useZustandStore } from './zustandStore.js';

export const ZustandCounter = (): JSX.Element => {
  const count = useZustandStore((s) => s.count);
  const increment = useZustandStore((s) => s.increment);
  const decrement = useZustandStore((s) => s.decrement);
  const addBy = useZustandStore((s) => s.addBy);
  const reset = useZustandStore((s) => s.reset);
  return (
    <section aria-label="zustand-counter">
      <h2>Zustand Counter</h2>
      <p>
        count: <span data-testid="zustand-counter-value">{count}</span>
      </p>
      <button onClick={decrement}>−</button>
      <button onClick={increment}>+</button>
      <button onClick={() => addBy(5)}>+5</button>
      <button onClick={reset}>reset</button>
    </section>
  );
};

ZustandCounter.displayName = 'ZustandCounter';
