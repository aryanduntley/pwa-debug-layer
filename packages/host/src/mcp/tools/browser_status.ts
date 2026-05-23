import {
  okResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  defaultLaunchDeps,
  getLaunchRegistry,
} from '../../browser_launch/node_deps.js';
import type { LaunchRecord } from '../../browser_launch/registry.js';

const inputSchema = {} as Record<string, never>;

type ConnectionInfo = {
  readonly extensionId: string;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
};

/**
 * Injected effects so the report is testable without a real registry / fetch /
 * live IPC server.
 */
export type BrowserStatusDeps = {
  readonly listLaunches: () => readonly LaunchRecord[];
  readonly probePort: (port: number) => Promise<boolean>;
  readonly listConnections: () => readonly ConnectionInfo[];
  readonly now: () => number;
};

export const browserStatusCore = async (
  deps: BrowserStatusDeps,
): Promise<ToolResponse> => {
  const launches = deps.listLaunches();

  // Re-probe each distinct launch port once for current liveness.
  const ports = [...new Set(launches.map((l) => l.port))];
  const liveness = new Map<number, boolean>();
  await Promise.all(
    ports.map(async (p) => {
      liveness.set(p, await deps.probePort(p));
    }),
  );
  const managedLaunches = launches.map((l) =>
    Object.freeze({ ...l, debugPortLive: liveness.get(l.port) ?? false }),
  );

  const now = deps.now();
  const activeExtensions = deps.listConnections().map((c) =>
    Object.freeze({ ...c, heartbeatAgeMs: now - c.lastSeenAt }),
  );

  const next_steps: string[] = [];
  if (managedLaunches.length === 0) {
    next_steps.push(
      'No browsers launched this host session. Use pdl_launch_browser to start one.',
    );
  } else {
    const dead = managedLaunches.filter((l) => !l.debugPortLive);
    if (dead.length > 0) {
      next_steps.push(
        `${dead.length} launched browser(s) no longer answer their debug port (closed/crashed): ${dead.map((d) => `${d.browser}:${d.port}`).join(', ')}. Re-run pdl_launch_browser to relaunch.`,
      );
    }
    const live = managedLaunches.filter((l) => l.debugPortLive && l.browserUrl);
    if (live.length > 0) {
      next_steps.push(
        `Live debug ports: ${live.map((l) => l.browserUrl).join(', ')}. Register chrome-devtools-mcp against one: \`claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl <url>\`.`,
      );
    }
  }
  if (activeExtensions.length === 0) {
    next_steps.push(
      'No pwa-debug extension is connected to the host right now. Sandbox launches preload it (give it a moment); in existing mode, ensure host_register_extension has run and the extension was reloaded.',
    );
  } else {
    const freshest = Math.min(...activeExtensions.map((e) => e.heartbeatAgeMs));
    next_steps.push(
      `${activeExtensions.length} extension(s) connected; newest heartbeat ${freshest}ms ago. Call session_ping for a full page-world round-trip.`,
    );
  }

  return okResponse({ managedLaunches, activeExtensions }, next_steps);
};

export const browserStatusHandler = async (
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const probeDebugPort = defaultLaunchDeps().probeDebugPort;
  return browserStatusCore({
    listLaunches: () => getLaunchRegistry().list(),
    probePort: probeDebugPort,
    listConnections: () => ctx.ipcServer.listConnections(),
    now: Date.now,
  });
};

export const browserStatusTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'pdl_browser_status',
  description:
    'Live state of the browsers pdl_launch_browser has started or attached to: each managed launch (browser, profile mode, port, pid, browserUrl) with a fresh debug-port liveness re-probe, plus the pwa-debug extension connections (extensionId + lastSeenAt heartbeat age). Cheap, no side effects. Use it to confirm a launch is still alive, find the browserUrl to hand to chrome-devtools-mcp, or see whether the extension SW is connected. Launch records persist across host restarts (launches.json); the liveness re-probe distinguishes still-running browsers from ones that have since closed. Follow next_steps[].',
  inputSchema,
  handler: browserStatusHandler,
});
