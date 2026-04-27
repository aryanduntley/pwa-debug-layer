import { runNmhMode } from './modes/nmh_mode.js';
import { runMcpMode } from './modes/mcp_mode.js';

export type RunMode = 'nmh' | 'mcp';

export const detectMode = (argv: readonly string[]): RunMode => {
  const arg1 = argv[1];
  return typeof arg1 === 'string' && arg1.startsWith('chrome-extension://') ? 'nmh' : 'mcp';
};

export const main = async (argv: readonly string[] = process.argv): Promise<void> => {
  if (detectMode(argv) === 'nmh') {
    await runNmhMode({
      origin: argv[1] ?? '',
      manifestPath: argv[2] ?? '',
    });
    return;
  }
  await runMcpMode();
};

main().catch((err) => {
  process.stderr.write(`[pwa-debug-host] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
