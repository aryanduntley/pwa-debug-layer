import { describe, it, expect, afterEach } from 'vitest';
import { buildPopupState } from '../../src/captures/popup_snapshot.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildPopupState — portal (element contentRoot)', () => {
  it('captures title from a heading, visible text, and action buttons', () => {
    const node = document.createElement('div');
    node.innerHTML = `
      <h2>Connect a wallet</h2>
      <p>Choose how you want to connect.</p>
      <button>MetaMask</button>
      <button>Cancel</button>
      <span role="button">WalletConnect</span>
      <a href="#">not a button</a>`;
    document.body.appendChild(node);

    const state = buildPopupState(node, node);

    expect(state.visible).toBe(true);
    expect(state.title).toBe('Connect a wallet');
    expect(state.text).toContain('Choose how you want to connect.');
    expect(state.buttons).toEqual([
      { label: 'MetaMask', role: 'button' },
      { label: 'Cancel', role: 'button' },
      { label: 'WalletConnect', role: 'button' },
    ]);
    expect(state.content?.tagName).toBe('DIV');
  });

  it('prefers an explicit aria-label over a heading for the title', () => {
    const node = document.createElement('div');
    node.setAttribute('aria-label', 'Wallet connect dialog');
    node.innerHTML = '<h2>Ignored heading</h2>';
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.title).toBe('Wallet connect dialog');
  });

  it('does not let the title swallow the whole body text', () => {
    const node = document.createElement('div');
    node.innerHTML = '<p>Some long modal body without a heading or label.</p>';
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.title).toBeUndefined();
    expect(state.text).toContain('Some long modal body');
  });
});

describe('buildPopupState — shadow (ShadowRoot contentRoot)', () => {
  it('snapshots content from inside an open shadow root', () => {
    const host = document.createElement('w3m-modal');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<h1>Approve transaction</h1><button>Approve</button>';

    const state = buildPopupState(host, root);

    expect(state.visible).toBe(true);
    expect(state.title).toBe('Approve transaction');
    expect(state.buttons).toEqual([{ label: 'Approve', role: 'button' }]);
    expect(state.content?.tagName).toBe('#fragment');
  });
});

describe('buildPopupState — shadow-piercing (nested shadow roots)', () => {
  it('composes title, text, and buttons across nested open shadow boundaries', () => {
    // Mirrors a component-based widget (Reown): the top-level host has an open
    // shadow root, but the visible content lives in nested components' OWN open
    // shadow roots that textContent/querySelectorAll would never reach.
    const host = document.createElement('w3m-modal');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('w3m-router');
    root.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<h1>Connect a wallet</h1><p>Choose a wallet to continue.</p>';
    const btnHost = document.createElement('wui-button');
    innerRoot.appendChild(btnHost);
    const btnRoot = btnHost.attachShadow({ mode: 'open' });
    btnRoot.innerHTML = '<button>MetaMask</button>';

    const state = buildPopupState(host, root);

    expect(state.title).toBe('Connect a wallet');
    expect(state.text).toContain('Choose a wallet to continue');
    expect(state.buttons).toEqual([{ label: 'MetaMask', role: 'button' }]);
  });

  it('surfaces an in-widget alert/failure rendered inside a nested shadow root', () => {
    const host = document.createElement('w3m-modal');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const view = document.createElement('w3m-connecting-view');
    root.appendChild(view);
    const viewRoot = view.attachShadow({ mode: 'open' });
    viewRoot.innerHTML =
      '<div role="alert">Connection failed: user rejected the request.</div>';

    const state = buildPopupState(host, root);

    expect(state.alerts).toEqual([
      'Connection failed: user rejected the request.',
    ]);
    expect(state.failure?.reason).toBe(
      'Connection failed: user rejected the request.',
    );
  });

  it('composes slotted (projected) light-DOM text through <slot>', () => {
    const host = document.createElement('w3m-modal');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="wrap"><slot></slot></div>';
    // Light-DOM child projected into the slot (how component widgets pass content).
    const light = document.createElement('span');
    light.textContent = 'Projected wallet label';
    host.appendChild(light);

    const state = buildPopupState(host, root);
    expect(state.text).toContain('Projected wallet label');
  });

  it('does not descend into closed shadow roots', () => {
    const host = document.createElement('w3m-modal');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    root.appendChild(inner);
    const closed = inner.attachShadow({ mode: 'closed' });
    closed.innerHTML = '<h1>Hidden inside closed shadow</h1>';

    const state = buildPopupState(host, root);
    expect(state.title).toBeUndefined();
  });
});

describe('buildPopupState — caps and visibility', () => {
  it('caps visible text and flags truncated', () => {
    const node = document.createElement('div');
    node.textContent = 'x'.repeat(5000);
    document.body.appendChild(node);

    const state = buildPopupState(node, node, { textCap: 100 });
    expect(state.text).toHaveLength(100);
    expect(state.truncated).toBe(true);
  });

  it('caps the number of buttons collected', () => {
    const node = document.createElement('div');
    for (let i = 0; i < 10; i += 1) {
      const b = document.createElement('button');
      b.textContent = `btn-${i}`;
      node.appendChild(b);
    }
    document.body.appendChild(node);

    const state = buildPopupState(node, node, { maxButtons: 3 });
    expect(state.buttons).toHaveLength(3);
  });

  it('reports visible=false for a detached host', () => {
    const node = document.createElement('div');
    node.innerHTML = '<h2>Hidden</h2>';
    // not appended to the document
    const state = buildPopupState(node, node);
    expect(state.visible).toBe(false);
  });
});

describe('buildPopupState — alerts and failure detection', () => {
  it('collects [role=alert] text and derives a failure reason from it', () => {
    const node = document.createElement('div');
    node.innerHTML = `
      <h2>Connect</h2>
      <div role="alert">Connection failed: user rejected the request.</div>`;
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.alerts).toEqual([
      'Connection failed: user rejected the request.',
    ]);
    expect(state.failure?.reason).toBe(
      'Connection failed: user rejected the request.',
    );
  });

  it('derives a failure from an error-styled element when there is no alert', () => {
    const node = document.createElement('div');
    node.innerHTML = '<span class="error-banner">Request was denied</span>';
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.alerts).toBeUndefined();
    expect(state.failure?.reason).toBe('Request was denied');
  });

  it('does not flag a healthy modal as a failure', () => {
    const node = document.createElement('div');
    node.innerHTML = '<h2>Connect a wallet</h2><button>MetaMask</button>';
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.failure).toBeUndefined();
    expect(state.alerts).toBeUndefined();
  });

  it('treats a polite aria-live region as an alert source', () => {
    const node = document.createElement('div');
    node.innerHTML = '<div aria-live="polite">Something went wrong, try again</div>';
    document.body.appendChild(node);

    const state = buildPopupState(node, node);
    expect(state.alerts).toHaveLength(1);
    expect(state.failure?.reason).toContain('Something went wrong');
  });
});
