import { useState } from 'react';

export type CounterProps = {
  readonly initial: number;
  readonly step: number;
};

export const Counter = ({ initial, step }: CounterProps): JSX.Element => {
  const [count, setCount] = useState(initial);
  return (
    <section>
      <p>counter-marker: {count}</p>
      <button type="button" onClick={() => setCount((c) => c - step)}>
        -
      </button>
      <button type="button" onClick={() => setCount((c) => c + step)}>
        +
      </button>
    </section>
  );
};

Counter.displayName = 'Counter';
