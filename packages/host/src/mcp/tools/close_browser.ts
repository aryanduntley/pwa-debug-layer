import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  getLaunchRegistry,
  terminateManagedBrowserImpl,
  discardProfileDirImpl,
  type TerminateOutcome,
} from '../../browser_launch/node_deps.js';
import { planClose } from '../../browser_launch/close_plan.js';
import type { LaunchRecord } from '../../browser_launch/registry.js';

const BROWSERS = [
  'chrome',
  'chromium',
  'edge',
  'brave',
  'vivaldi',
  'opera',
] as const;

const SESSIONS = ['persist', 'discard', 'detach'] as const;

const inputSchema = {
  browser: z.enum(BROWSERS).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  pid: z.number().int().positive().optional(),
  all: z.boolean().optional(),
  session: z.enum(SESSIONS).optional(),
};

/**
 * Injected effects so the orchestration (plan → terminate/discard → deregister)
 * is testable without a real registry / process kill / fs.
 */
export type CloseBrowserDeps = {
  readonly listLaunches: () => readonly LaunchRecord[];
  readonly terminate: (record: LaunchRecord) => Promise<TerminateOutcome>;
  readonly discardProfile: (dir: string) => boolean | Promise<boolean>;
  readonly removeFromRegistry: (port: number) => void;
};

type ClosedEntry = {
  readonly browser: string;
  readonly port: number;
  readonly pid: number | null;
  readonly profileType: string;
  readonly action: 'terminated' | 'detached';
  readonly closed: boolean;
  readonly method?: string;
  readonly profileDiscarded?: boolean;
  readonly note?: string;
};

/**
 * Close managed browser launch(es): resolve the plan (which encodes the safety
 * rules — never kill an attached/unmanaged browser, never delete a user
 * profile), then for each: detach drops the registry record; terminate stops
 * the process we spawned, optionally discards the sandbox profile, and drops
 * the record once the port is confirmed down. Effects arrive via deps.
 */
export const closeBrowserCore = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  deps: CloseBrowserDeps,
): Promise<ToolResponse> => {
  const session = args.session ?? 'persist';
  const target = {
    ...(args.browser !== undefined ? { browser: args.browser } : {}),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.pid !== undefined ? { pid: args.pid } : {}),
    ...(args.all !== undefined ? { all: args.all } : {}),
  };

  const plan = planClose(deps.listLaunches(), target, session);
  if (plan.length === 0) {
    return errorResponse(
      'No managed launch matched. pdl_close_browser only acts on browsers pwa-debug launched (see pdl_browser_status) — it never touches your own browser. Pass browser, port, or pid to target one, or all:true to close every managed launch.',
      [
        'Call pdl_browser_status to see the managed launches and their ports.',
      ],
    );
  }

  const closed: ClosedEntry[] = [];
  for (const p of plan) {
    const base = {
      browser: p.record.browser,
      port: p.record.port,
      pid: p.record.pid,
      profileType: p.record.profileType,
    };
    if (p.action === 'detach') {
      deps.removeFromRegistry(p.record.port);
      closed.push(
        Object.freeze({
          ...base,
          action: 'detached',
          closed: false,
          ...(p.note !== undefined ? { note: p.note } : {}),
        }),
      );
      continue;
    }
    const outcome = await deps.terminate(p.record);
    let profileDiscarded: boolean | undefined;
    if (outcome.closed && p.discardProfile && p.record.userDataDir) {
      profileDiscarded = await deps.discardProfile(p.record.userDataDir);
    }
    if (outcome.closed) deps.removeFromRegistry(p.record.port);
    closed.push(
      Object.freeze({
        ...base,
        action: 'terminated',
        closed: outcome.closed,
        method: outcome.method,
        ...(profileDiscarded !== undefined ? { profileDiscarded } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
      }),
    );
  }

  const next_steps: string[] = [];
  const failed = closed.filter((c) => c.action === 'terminated' && !c.closed);
  if (failed.length > 0) {
    next_steps.push(
      `Could not confirm shutdown for ${failed.map((f) => `${f.browser}:${f.port}`).join(', ')} (debug port still answering). The browser may be mid-shutdown — re-check with pdl_browser_status.`,
    );
  }
  const notDiscarded = closed.filter((c) => c.profileDiscarded === false);
  if (notDiscarded.length > 0) {
    next_steps.push(
      `Profile dir could not be fully removed for ${notDiscarded.map((c) => `${c.browser}:${c.port}`).join(', ')} (browser may still be flushing it to disk). Re-check the dir; it can be deleted manually if it persists.`,
    );
  }
  const detached = closed.filter((c) => c.action === 'detached');
  if (detached.length > 0) {
    next_steps.push(
      `Detached ${detached.length} launch(es) from the registry without terminating (attached/unmanaged or session:'detach'). The browser(s) keep running.`,
    );
  }
  if (next_steps.length === 0) {
    next_steps.push(
      'Managed launch(es) closed and removed from the registry. pdl_browser_status will no longer list them; pdl_launch_browser can start a fresh one.',
    );
  }

  return okResponse({ closed }, next_steps);
};

export const closeBrowserHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  _ctx: ToolContext,
): Promise<ToolResponse> =>
  closeBrowserCore(args, {
    listLaunches: () => getLaunchRegistry().list(),
    terminate: terminateManagedBrowserImpl,
    discardProfile: discardProfileDirImpl,
    removeFromRegistry: (port) => getLaunchRegistry().remove(port),
  });

export const closeBrowserTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pdl_close_browser',
  description:
    "Cleanly close a browser that pdl_launch_browser started — the symmetric counterpart to launch. Operates STRICTLY off the managed-launch registry, so it can NEVER touch your own/normal browser: a launch we only ATTACHED to (didn't spawn) is detached from the registry, never killed. Shutdown prefers a clean CDP Browser.close (no 'restore tabs' crash prompt), falling back to SIGTERM then SIGKILL of the spawned process. Args: target by browser, port, or pid (or all:true for every managed launch); session? = 'persist' (default — keep the profile dir), 'discard' (also delete the sandbox profile dir; ignored for the user's 'existing' profile), or 'detach' (drop the registry record, leave the browser running). With no target it does nothing (returns an error) — closing requires intent. Follow next_steps[].",
  inputSchema,
  handler: closeBrowserHandler,
});
