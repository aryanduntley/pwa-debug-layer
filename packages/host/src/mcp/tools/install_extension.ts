import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  copyDir,
  defaultExtensionTargetDir,
  resolveExtensionPath,
} from '../../browser_launch/node_deps.js';

const inputSchema = {
  target: z.string().min(1).optional(),
};

/** Injected effects so the copy flow is testable without real fs. */
export type InstallExtensionDeps = {
  readonly resolveSource: () => string | null;
  readonly defaultTarget: () => string;
  readonly copyDir: (src: string, dest: string) => Promise<void>;
};

export const installExtensionCore = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  deps: InstallExtensionDeps,
): Promise<ToolResponse> => {
  const source = deps.resolveSource();
  if (!source) {
    return errorResponse(
      'The bundled pwa-debug extension was not found to install.',
      [
        'Build it first: `pnpm --filter @pwa-debug/extension build`, or set PWA_DEBUG_EXTENSION_PATH to an unpacked extension dir. (Once the extension is published, a Web Store link will be offered here instead.)',
      ],
    );
  }

  const dest = args.target ?? deps.defaultTarget();
  try {
    await deps.copyDir(source, dest);
  } catch (err) {
    return errorResponse(
      `Failed to copy the extension to ${dest}: ${(err as Error).message}`,
      ['Check write permission for the target directory, or pass a different `target`.'],
    );
  }

  return okResponse({ source, dest }, [
    `Copied the pwa-debug extension to ${dest}.`,
    `Install it unpacked: open chrome://extensions (or brave://extensions), enable "Developer mode", click "Load unpacked", and select ${dest}.`,
    'After loading, read the service-worker console for `[pwa-debug/sw] id=<id>`, call host_register_extension with that ID, then reload the extension.',
    'Prefer zero setup? pdl_launch_browser with mode=sandbox-persistent preloads this extension automatically — no manual unpacked install needed.',
  ]);
};

export const installExtensionHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  _ctx: ToolContext,
): Promise<ToolResponse> =>
  installExtensionCore(args, {
    resolveSource: () => resolveExtensionPath(process.env),
    defaultTarget: () => defaultExtensionTargetDir(process.env),
    copyDir,
  });

export const installExtensionTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'pdl_install_extension',
  description:
    "Copy the bundled pwa-debug extension to a folder for manual unpacked install in a Chromium browser. Args: target? (destination dir; defaults to ~/Downloads/pwa-debug-extension). Returns { source, dest } and step-by-step chrome://extensions Developer-mode 'Load unpacked' instructions in next_steps, plus the host_register_extension follow-up. Errors with build guidance if the bundled extension isn't present. Note: pdl_launch_browser sandbox-persistent/sandbox-temp preload the extension automatically, so this tool is only needed for installing into the user's normal (existing-mode) profile.",
  inputSchema,
  handler: installExtensionHandler,
});
