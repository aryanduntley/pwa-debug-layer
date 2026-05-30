import { dirname, join } from 'node:path';

export type SocketEnvSnapshot = {
  readonly HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly PWA_DEBUG_SOCKET?: string;
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
  // Confinement-stable override. Baked into the NMH launcher at install time
  // with the host's REAL (unconfined) socket path. snap/flatpak remap
  // XDG_CONFIG_HOME/HOME inside the sandbox, so an NMH that re-derived the
  // socket from XDG would target a confined path the MCP host never listens on
  // ('Native host has exited'). When this is set it wins, so the sandboxed NMH
  // connects to the exact socket the host owns. Unset on native installs ->
  // the XDG resolution below applies unchanged.
  if (env.PWA_DEBUG_SOCKET && env.PWA_DEBUG_SOCKET.length > 0) {
    return env.PWA_DEBUG_SOCKET;
  }
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
