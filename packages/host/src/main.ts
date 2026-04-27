import { runNmhMode } from './modes/nmh_mode.js';
import { runMcpMode } from './modes/mcp_mode.js';

export type RunMode = 'nmh' | 'mcp';

// userArgs are process.argv.slice(2) — i.e. everything after [nodePath, scriptPath].
// Chrome/Brave native-messaging passes the calling extension's origin as the first
// user arg on Linux/macOS; on Windows it appends a `--parent-window=<HWND>` arg.
export const detectMode = (userArgs: readonly string[]): RunMode => {
  const a0 = userArgs[0];
  return typeof a0 === 'string' && a0.startsWith('chrome-extension://') ? 'nmh' : 'mcp';
};

export const main = async (userArgs: readonly string[] = process.argv.slice(2)): Promise<void> => {
  if (detectMode(userArgs) === 'nmh') {
    await runNmhMode({ origin: userArgs[0] ?? '' });
    return;
  }
  await runMcpMode();
};

main().catch((err) => {
  process.stderr.write(`[pwa-debug-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
