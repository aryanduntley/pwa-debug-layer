import { dirname, join } from 'node:path';

export type SocketEnvSnapshot = {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
};

const PIPE_NAME = 'pwa-debug-mcp';

const posixRunRoot = (env: SocketEnvSnapshot): string => {
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0) {
    return join(env.XDG_CONFIG_HOME, 'pwa-debug', 'run');
  }
  if (env.HOME) {
    return join(env.HOME, '.config', 'pwa-debug', 'run');
  }
  throw new Error(
    'socket_path: cannot resolve run dir; HOME and XDG_CONFIG_HOME are both unset',
  );
};

export const defaultSocketPath = (
  env: SocketEnvSnapshot = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === 'win32') return `\\\\.\\pipe\\${PIPE_NAME}`;
  return join(posixRunRoot(env), 'mcp.sock');
};

export const socketParentDir = (
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (platform === 'win32') return null;
  return dirname(socketPath);
};
