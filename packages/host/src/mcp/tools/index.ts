import type { ToolDef } from '../tool_registry.js';
import { hostStatusTool } from './host_status.js';
import { hostRegisterExtensionTool } from './host_register_extension.js';
import { hostUnregisterExtensionTool } from './host_unregister_extension.js';
import { hostListRegistrationsTool } from './host_list_registrations.js';
import { hostResetTool } from './host_reset.js';
import { sessionPingTool } from './session_ping.js';

// Each per-tool ToolDef<X> is variant-incompatible with ToolDef<ZodRawShape>
// (handler arg is contravariant). The runtime contract is identical, so we
// cast at this boundary; registerTools only reads the description+inputSchema
// and forwards the parsed args back to the handler unchanged.
export const TOOLS: readonly ToolDef[] = Object.freeze([
  hostStatusTool,
  hostRegisterExtensionTool,
  hostUnregisterExtensionTool,
  hostListRegistrationsTool,
  hostResetTool,
  sessionPingTool,
] as unknown as readonly ToolDef[]);
