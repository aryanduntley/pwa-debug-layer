import { Counter } from './Counter.js';
import { TodoList } from './TodoList.js';
import { UserProfile } from './UserProfile.js';
import { NestedSection } from './NestedSection.js';
import { ReduxCounter } from './ReduxCounter.js';

export const App = (): JSX.Element => (
  <div className="app">
    <h1>pwa-debug React fixture</h1>
    <Counter initial={0} step={1} />
    <TodoList />
    <UserProfile name="Alice" role="admin" />
    <NestedSection />
    <ReduxCounter />
  </div>
);

App.displayName = 'App';
