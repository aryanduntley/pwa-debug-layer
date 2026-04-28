import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stderr, stdin } from 'node:process';
import { registerTools } from '../mcp/tool_registry.js';
import { TOOLS } from '../mcp/tools/index.js';
import { createIpcServer } from '../mcp/ipc/ipc_server.js';
import { defaultSocketPath, socketParentDir } from '../mcp/ipc/socket_path.js';

const FALLBACK_VERSION = '0.0.0';

const readHostVersion = async (): Promise<string> => {
  const mainJsPath = process.argv[1];
  if (typeof mainJsPath !== 'string' || mainJsPath === '') {
    return FALLBACK_VERSION;
  }
  try {
    const pkgPath = join(dirname(mainJsPath), '..', 'package.json');
    const parsed = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof parsed.version === 'string' ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
};

const waitForShutdown = (): Promise<string> =>
  new Promise<string>((resolve) => {
    const onceOnly = (reason: string): void => resolve(reason);
    stdin.once('end', () => onceOnly('stdin EOF'));
    process.once('SIGINT', () => onceOnly('SIGINT'));
    process.once('SIGTERM', () => onceOnly('SIGTERM'));
  });

export const runMcpMode = async (): Promise<void> => {
  const socketPath = defaultSocketPath();
  const parentDir = socketParentDir(socketPath);
  if (parentDir !== null) {
    await mkdir(parentDir, { recursive: true });
  }

  const hostVersion = await readHostVersion();
  const ipcServer = await createIpcServer({ socketPath });

  try {
    const server = new McpServer({
      name: 'pwa-debug',
      version: '0.0.0-m4',
    });

    registerTools(server, TOOLS, { ipcServer, hostVersion });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    stderr.write(
      `[pwa-debug-host mcp] server up on stdio; ${TOOLS.length} tools registered; ipc socket=${socketPath}\n`,
    );

    const reason = await waitForShutdown();
    stderr.write(`[pwa-debug-host mcp] ${reason}; shutting down\n`);
  } finally {
    await ipcServer.close();
    stderr.write('[pwa-debug-host mcp] ipc server closed\n');
  }
};
