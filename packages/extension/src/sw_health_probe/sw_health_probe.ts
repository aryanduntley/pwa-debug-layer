export type PageWorldErrorCode =
  | 'cs_not_attached_refresh_tab'
  | 'page_blocks_scripts'
  | 'page_world_blocked'
  | 'restricted_url'
  | 'no_active_tab'
  | 'cs_inject_failed';

export type ProbeResult = 'scripts_run' | 'scripts_blocked';

const PROBE_TOKEN = '__pwa_debug_probe__' as const;

export const probeTabScripting = async (
  tabId: number,
): Promise<ProbeResult> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => '__pwa_debug_probe__',
    });
    return 'scripts_run';
  } catch {
    return 'scripts_blocked';
  }
};

const RESTRICTED_PROTOCOLS: ReadonlyArray<string> = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'devtools:',
  'edge:',
  'brave:',
  'view-source:',
  'file:',
];

const RESTRICTED_HOST_SUFFIXES: ReadonlyArray<string> = [
  'chromewebstore.google.com',
  'chrome.google.com',
];

export const classifyRestrictedUrl = (
  url: string | undefined,
): 'restricted_url' | null => {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (RESTRICTED_PROTOCOLS.includes(parsed.protocol)) return 'restricted_url';
  if (RESTRICTED_HOST_SUFFIXES.includes(parsed.hostname)) {
    return 'restricted_url';
  }
  return null;
};

export type ClassifiedFailure = {
  readonly code: PageWorldErrorCode;
  readonly message: string;
};

export type ClassifyDispatchFailureInput = {
  readonly tabId: number;
  readonly url: string | undefined;
  readonly lastErrorMessage: string;
};

export const classifyDispatchFailure = async (
  input: ClassifyDispatchFailureInput,
): Promise<ClassifiedFailure> => {
  const restricted = classifyRestrictedUrl(input.url);
  if (restricted !== null) {
    return { code: 'restricted_url', message: input.lastErrorMessage };
  }
  const probe = await probeTabScripting(input.tabId);
  if (probe === 'scripts_blocked') {
    return { code: 'page_blocks_scripts', message: input.lastErrorMessage };
  }
  return {
    code: 'cs_not_attached_refresh_tab',
    message: input.lastErrorMessage,
  };
};

export type SelfHealResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const CS_BUNDLE_PATH = 'content-script.js' as const;
const PAGE_WORLD_BUNDLE_PATH = 'page-world.js' as const;

export const selfHealCsAttachment = async (
  tabId: number,
): Promise<SelfHealResult> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: [CS_BUNDLE_PATH],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: [PAGE_WORLD_BUNDLE_PATH],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
};

export { PROBE_TOKEN };
