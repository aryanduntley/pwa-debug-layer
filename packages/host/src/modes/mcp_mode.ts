import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stderr, stdin } from 'node:process';
import { registerTools } from '../mcp/tool_registry.js';
import { TOOLS } from '../mcp/tools/index.js';

export const runMcpMode = async (): Promise<void> => {
  const server = new McpServer({
    name: 'pwa-debug',
    version: '0.0.0-m3',
  });

  registerTools(server, TOOLS);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  stderr.write(
    `[pwa-debug-host mcp] server up on stdio; ${TOOLS.length} tools registered\n`,
  );

  return new Promise<void>((resolve) => {
    stdin.once('end', () => {
      stderr.write('[pwa-debug-host mcp] stdin EOF; shutting down\n');
      resolve();
    });
  });
};
