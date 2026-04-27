import { z } from 'zod';
import {
  okResponse,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';

export const sessionPingHandler = async (): Promise<ToolResponse> => {
  return okResponse(
    {
      hostUnreachable: true,
      reason: 'M3-skeleton: IPC bridge not yet wired',
      hint:
        'Wait until the IPC bridge between MCP-mode and NMH-mode (M3 task item 25) is wired. Until then, session_ping cannot route to a connected NMH instance even if the extension is connected.',
      hostBinaryPath: process.argv[1] ?? '',
    },
    [
      'M3-skeleton stub. After item 25 ships, this tool will route a ping over the IPC socket to a connected NMH instance, await the pong, and return the round-trip metadata. For now, run host_status to confirm the manifest install side is correct.',
    ],
  );
};

export const sessionPingTool: ToolDef<Record<string, never>> = Object.freeze({
  name: 'session_ping',
  description:
    'Sends a ping through the full MCP → IPC → NMH → SW chain and returns the round-trip metadata. M3 acceptance proof. M3-SKELETON STATUS: returns hostUnreachable:true until the IPC bridge ships (M3 item 25). When ok:true with hostUnreachable:true, follow next_steps to surface the missing-piece state. Once IPC ships, returns { hostVersion, hostUptimeMs, extensionId, swUptimeMs } on success.',
  inputSchema: {} as Record<string, never>,
  handler: sessionPingHandler,
});

void z;
