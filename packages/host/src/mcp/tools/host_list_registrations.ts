import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { defaultStatePath, loadHostState } from '../../state/host_state.js';

export const hostListRegistrationsHandler = async (): Promise<ToolResponse> => {
  try {
    const state = await loadHostState(defaultStatePath());
    return okResponse(
      { extensionIds: [...state.extensionIds] },
      state.extensionIds.length === 0
        ? [
            'No extension IDs registered. Use chrome-devtools-mcp to read the pwa-debug SW console for `[pwa-debug/sw] id=<id>`, then call host_register_extension.',
          ]
        : [
            'For full setup state including manifest paths and (eventually) active connections, call host_status.',
          ],
    );
  } catch (err) {
    return errorResponse(
      `host_list_registrations failed: ${(err as Error).message}`,
      ['Filesystem error reading state. Check ~/.config/pwa-debug/state.json.'],
    );
  }
};

export const hostListRegistrationsTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'host_list_registrations',
  description:
    'Lists registered extension IDs from the host state file. Cheap read-only view; does NOT verify that manifests are on disk or that any extension is connected. For the full setup picture, prefer host_status.',
  inputSchema: {} as Record<string, never>,
  handler: hostListRegistrationsHandler,
});

void z;
