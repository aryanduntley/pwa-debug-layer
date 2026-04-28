import { describe, it, expect } from 'vitest';
import {
  defaultSocketPath,
  socketParentDir,
} from '../../../src/mcp/ipc/socket_path.js';

describe('defaultSocketPath — POSIX', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    expect(defaultSocketPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' }, 'linux')).toBe(
      '/x/pwa-debug/run/mcp.sock',
    );
  });

  it('falls back to HOME/.config when XDG_CONFIG_HOME unset', () => {
    expect(defaultSocketPath({ HOME: '/h' }, 'linux')).toBe(
      '/h/.config/pwa-debug/run/mcp.sock',
    );
  });

  it('treats empty XDG_CONFIG_HOME as unset', () => {
    expect(defaultSocketPath({ XDG_CONFIG_HOME: '', HOME: '/h' }, 'linux')).toBe(
      '/h/.config/pwa-debug/run/mcp.sock',
    );
  });

  it('uses the same POSIX path on darwin', () => {
    expect(defaultSocketPath({ HOME: '/Users/u' }, 'darwin')).toBe(
      '/Users/u/.config/pwa-debug/run/mcp.sock',
    );
  });

  it('throws when both HOME and XDG_CONFIG_HOME are unset on POSIX', () => {
    expect(() => defaultSocketPath({}, 'linux')).toThrow(/HOME and XDG_CONFIG_HOME/);
  });
});

describe('defaultSocketPath — Windows', () => {
  it('returns the named-pipe path regardless of env', () => {
    expect(defaultSocketPath({}, 'win32')).toBe('\\\\.\\pipe\\pwa-debug-mcp');
    expect(defaultSocketPath({ HOME: '/h' }, 'win32')).toBe(
      '\\\\.\\pipe\\pwa-debug-mcp',
    );
  });
});

describe('socketParentDir', () => {
  it('returns dirname on POSIX', () => {
    expect(socketParentDir('/h/.config/pwa-debug/run/mcp.sock', 'linux')).toBe(
      '/h/.config/pwa-debug/run',
    );
    expect(socketParentDir('/Users/u/.config/pwa-debug/run/mcp.sock', 'darwin')).toBe(
      '/Users/u/.config/pwa-debug/run',
    );
  });

  it('returns null on Windows (named pipes have no fs parent)', () => {
    expect(socketParentDir('\\\\.\\pipe\\pwa-debug-mcp', 'win32')).toBeNull();
  });
});
