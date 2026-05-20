import { useSelector, useDispatch } from 'react-redux';
import {
  counterActions,
  type RootState,
  type AppDispatch,
} from './store.js';

export const ReduxCounter = (): JSX.Element => {
  const value = useSelector((s: RootState) => s.counter.value);
  const dispatch = useDispatch<AppDispatch>();
  return (
    <section aria-label="redux-counter">
      <h2>Redux Counter</h2>
      <p>
        value: <span data-testid="redux-counter-value">{value}</span>
      </p>
      <button onClick={() => dispatch(counterActions.decrement())}>
        −
      </button>
      <button onClick={() => dispatch(counterActions.increment())}>
        +
      </button>
      <button onClick={() => dispatch(counterActions.addBy(5))}>
        +5
      </button>
      <button onClick={() => dispatch(counterActions.reset())}>
        reset
      </button>
    </section>
  );
};

ReduxCounter.displayName = 'ReduxCounter';
