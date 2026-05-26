import type { ToolDef } from '../tool_registry.js';
import { hostStatusTool } from './host_status.js';
import { hostRegisterExtensionTool } from './host_register_extension.js';
import { hostUnregisterExtensionTool } from './host_unregister_extension.js';
import { hostListRegistrationsTool } from './host_list_registrations.js';
import { hostResetTool } from './host_reset.js';
import { sessionPingTool } from './session_ping.js';
import { recentEventsTool } from './recent_events.js';
import { consoleTailTool } from './console_tail.js';
import { evaluateTool } from './evaluate.js';
import { networkTailTool } from './network_tail.js';
import { reactTreeTool } from './react_tree.js';
import { reactGetStateTool } from './react_get_state.js';
import { reactFindByTextTool } from './react_find_by_text.js';
import { reactFindByRoleTool } from './react_find_by_role.js';
import { vueTreeTool } from './vue_tree.js';
import { vueGetStateTool } from './vue_get_state.js';
import { vueFindByTextTool } from './vue_find_by_text.js';
import { vueFindByRoleTool } from './vue_find_by_role.js';
import { svelteComponentsTool } from './svelte_components.js';
import { svelteFindByTextTool } from './svelte_find_by_text.js';
import { svelteFindByRoleTool } from './svelte_find_by_role.js';
import { solidDetectTool } from './solid_detect.js';
import { solidFindByTextTool } from './solid_find_by_text.js';
import { solidFindByRoleTool } from './solid_find_by_role.js';
import { reduxGetStateTool } from './redux_get_state.js';
import { reduxSubscribeTool } from './redux_subscribe.js';
import { reduxTailTool } from './redux_tail.js';
import { reduxDispatchTool } from './redux_dispatch.js';
import { storeGetStateTool } from './store_get_state.js';
import { storeSubscribeTool } from './store_subscribe.js';
import { storeTailTool } from './store_tail.js';
import { storeDispatchTool } from './store_dispatch.js';
import { sourceMapResolveTool } from './source_map_resolve.js';
import { sessionRecordTool } from './session_record.js';
import { sessionReplayTool } from './session_replay.js';
import { settingsListSchemaTool } from './settings_list_schema.js';
import { settingsGetTool } from './settings_get.js';
import { settingsSetTool } from './settings_set.js';
import { launchBrowserTool } from './launch_browser.js';
import { browserStatusTool } from './browser_status.js';
import { closeBrowserTool } from './close_browser.js';
import { checkSetupTool } from './check_setup.js';
import { installExtensionTool } from './install_extension.js';
import { registerChromeDevtoolsTool } from './register_chrome_devtools.js';

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
  recentEventsTool,
  consoleTailTool,
  networkTailTool,
  evaluateTool,
  settingsListSchemaTool,
  settingsGetTool,
  settingsSetTool,
  reactTreeTool,
  reactGetStateTool,
  reactFindByTextTool,
  reactFindByRoleTool,
  vueTreeTool,
  vueGetStateTool,
  vueFindByTextTool,
  vueFindByRoleTool,
  svelteComponentsTool,
  svelteFindByTextTool,
  svelteFindByRoleTool,
  solidDetectTool,
  solidFindByTextTool,
  solidFindByRoleTool,
  storeGetStateTool,
  storeSubscribeTool,
  storeTailTool,
  storeDispatchTool,
  reduxGetStateTool,
  reduxSubscribeTool,
  reduxTailTool,
  reduxDispatchTool,
  sourceMapResolveTool,
  sessionRecordTool,
  sessionReplayTool,
  launchBrowserTool,
  browserStatusTool,
  closeBrowserTool,
  checkSetupTool,
  installExtensionTool,
  registerChromeDevtoolsTool,
] as unknown as readonly ToolDef[]);
