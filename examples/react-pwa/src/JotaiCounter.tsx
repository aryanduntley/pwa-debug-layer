import { useAtom } from 'jotai';
import { countAtom } from './jotaiStore.js';

export const JotaiCounter = (): JSX.Element => {
  const [count, setCount] = useAtom(countAtom);
  return (
    <section aria-label="jotai-counter">
      <h2>Jotai Counter</h2>
      <p>
        count: <span data-testid="jotai-counter-value">{count}</span>
      </p>
      <button onClick={() => setCount((c) => c - 1)}>−</button>
      <button onClick={() => setCount((c) => c + 1)}>+</button>
      <button onClick={() => setCount((c) => c + 5)}>+5</button>
      <button onClick={() => setCount(0)}>reset</button>
    </section>
  );
};

JotaiCounter.displayName = 'JotaiCounter';
