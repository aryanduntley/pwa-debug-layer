import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import {
  EMPTY_STATE,
  defaultStatePath,
  loadHostState,
  saveHostState,
} from '../../state/host_state.js';
import { findInstalledBrowsers } from '../../native-messaging/browser_paths.js';
import { removeHostManifestForBrowsers } from '../../native-messaging/manifest_writer.js';

const HOST_NAME = 'com.pwa_debug.host';

const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const inputSchema = { confirm: z.literal('reset') };

export const hostResetHandler = async (
  _args: z.infer<z.ZodObject<typeof inputSchema>>,
): Promise<ToolResponse> => {
  try {
    const statePath = defaultStatePath();
    const before = await loadHostState(statePath);
    const browsers = await findInstalledBrowsers(process.env, process.platform, fileExists);
    const deleted = await removeHostManifestForBrowsers(HOST_NAME, browsers);
    await saveHostState(statePath, {
      ...EMPTY_STATE,
      lastUpdated: new Date().toISOString(),
    });
    return okResponse(
      {
        idsRemoved: [...before.extensionIds],
        pathsDeleted: [...deleted],
      },
      [
        'All registrations cleared and host manifests deleted. Inform the user that any previously connected extensions will lose connectivity.',
        'To re-bootstrap, call host_register_extension with the desired extension ID.',
      ],
    );
  } catch (err) {
    return errorResponse(`host_reset failed: ${(err as Error).message}`, [
      'Filesystem error during reset. Check write permissions on ~/.config/pwa-debug/ and the per-browser NativeMessagingHosts dirs.',
    ]);
  }
};

export const hostResetTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'host_reset',
  description:
    'DESTRUCTIVE: removes ALL registered extension IDs and deletes the per-browser host manifests. Requires confirm:"reset" to invoke (a typed safety guard). Inform the user before calling. Use only when you want to start setup from scratch.',
  inputSchema,
  handler: hostResetHandler,
});
