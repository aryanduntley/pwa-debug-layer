import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  addChromeDevtoolsRegistration,
  readChromeDevtoolsRegistration,
  removeChromeDevtoolsRegistration,
  getLaunchRegistry,
  type ChromeDevtoolsRegistration,
  type ClaudeMcpResult,
} from '../../browser_launch/node_deps.js';
import { browserUrlFor } from '../../browser_launch/spawn_args.js';
import { cdpAddSnippet, cdpPortOf, expectedCdpPort } from './_cdp_registration.js';

const inputSchema = {
  port: z.number().int().positive().optional(),
};

/** Injected effects so the register flow is testable without the `claude` CLI. */
export type RegisterCdpDeps = {
  readonly readCdpRegistration: () => Promise<ChromeDevtoolsRegistration>;
  readonly runMcpAdd: (browserUrl: string) => Promise<ClaudeMcpResult>;
  readonly runMcpRemove: () => Promise<ClaudeMcpResult>;
  readonly defaultPort: () => number;
  readonly listManagedPorts: () => readonly { readonly port: number }[];
};

/**
 * Steps the user/agent follows AFTER the direct-MCP registration is written:
 * a full Claude Code restart is required (a mid-session add does not load, and
 * /mcp cannot load a newly-added server), then verify + rehydrate context, plus
 * the lower-friction plugin alternative that needs no restart.
 */
const postRegisterSteps = (browserUrl: string): readonly string[] => [
  `This is a DIRECT MCP registration, so a full Claude Code restart is required for chrome-devtools-mcp's tools to load — a mid-session add does not load, and /mcp cannot load a newly-added server.`,
  `BEFORE the user restarts: hand them a short context-handoff note (what we are working on + the next step) so they can paste it back after the restart and we continue seamlessly. Most users are not on a persistent-memory MCP, so the restart otherwise loses this conversation's context. See the chrome-devtools-coexistence skill.`,
  `After restarting, run /mcp to confirm chrome-devtools connected against ${browserUrl}, then call pdl_check_setup to re-verify.`,
  `Lower-friction alternative (NO restart): install chrome-devtools as a Claude Code PLUGIN instead of a direct MCP, then run /reload-plugins to hot-load it in this same session.`,
];

export const registerChromeDevtoolsCore = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  deps: RegisterCdpDeps,
): Promise<ToolResponse> => {
  const expectedPort = args.port ?? expectedCdpPort(deps.listManagedPorts(), deps.defaultPort());
  const browserUrl = browserUrlFor(expectedPort);
  const snippet = cdpAddSnippet(browserUrl);

  const reg = await deps.readCdpRegistration();
  const regPort = cdpPortOf(reg.browserUrl);

  // Already registered at the right port — nothing to write.
  if (reg.registered && regPort === expectedPort) {
    return okResponse(
      { action: 'noop', browserUrl, registration: reg },
      [
        `chrome-devtools-mcp is already registered against ${browserUrl}; no change needed.`,
        `If its tools are not visible, a restart (direct MCP) or /reload-plugins (plugin) is still pending — see the chrome-devtools-coexistence skill.`,
      ],
    );
  }

  // Registered but pointed at the wrong port — remove before re-adding.
  if (reg.registered) {
    const removed = await deps.runMcpRemove();
    if (!removed.ok) {
      return errorResponse(
        `chrome-devtools-mcp is registered at the wrong port (${reg.browserUrl}) but removing it failed: ${removed.error}`,
        [
          `Remove it manually: \`claude mcp remove chrome-devtools\`, then re-run this tool or run: \`${snippet}\`.`,
        ],
      );
    }
  }

  const added = await deps.runMcpAdd(browserUrl);
  if (!added.ok) {
    return errorResponse(
      `Failed to register chrome-devtools-mcp: ${added.error}`,
      [
        `Run it manually: \`${snippet}\`.`,
        'Ensure the `claude` CLI is installed and on PATH.',
      ],
    );
  }

  return okResponse(
    { action: reg.registered ? 're-registered' : 'registered', browserUrl, command: snippet },
    [
      `Registered chrome-devtools-mcp against ${browserUrl} (\`${snippet}\`).`,
      ...postRegisterSteps(browserUrl),
    ],
  );
};

export const registerChromeDevtoolsHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> =>
  registerChromeDevtoolsCore(args, {
    readCdpRegistration: readChromeDevtoolsRegistration,
    runMcpAdd: addChromeDevtoolsRegistration,
    runMcpRemove: removeChromeDevtoolsRegistration,
    defaultPort: () => ctx.settingsStore.getSetting('launch.defaultPort'),
    listManagedPorts: () =>
      getLaunchRegistry()
        .list()
        .map((l) => ({ port: l.port })),
  });

export const registerChromeDevtoolsTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pdl_register_chrome_devtools',
  description:
    "Register the separate, optional chrome-devtools-mcp server with Claude Code on the user's behalf, pinned to the active debug port. Runs `claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:<port>` via the `claude` CLI. Port resolves to: the `port` arg if given, else the active managed launch port (from pdl_launch_browser), else the host launch.defaultPort. Idempotent: no-op when already registered at the correct port; removes + re-adds when registered at the wrong port. IMPORTANT: this MUTATES the user's global (user-scope) MCP config — ALWAYS ask the user for confirmation before calling it. Because it writes a DIRECT MCP registration, a full Claude Code restart is required afterward for the tools to load (next_steps explains the restart, the context-handoff to hand the user before restarting, and the lower-friction plugin alternative that needs only /reload-plugins). Args: port? (override the debug port).",
  inputSchema,
  handler: registerChromeDevtoolsHandler,
});
