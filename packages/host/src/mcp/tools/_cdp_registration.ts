/**
 * Pure helpers shared by the chrome-devtools-mcp coexistence tools
 * (pdl_check_setup + pdl_register_chrome_devtools): build the port-correct
 * `claude mcp add` snippet, parse a browserUrl's port, and decide which debug
 * port chrome-devtools should attach to. No effects.
 */

/** The `claude mcp add` line for chrome-devtools-mcp, pinned to a debug-port URL. */
export const cdpAddSnippet = (browserUrl: string): string =>
  `claude mcp add chrome-devtools --scope user -- npx -y chrome-devtools-mcp@latest --browserUrl ${browserUrl}`;

/** Port component of a CDP browserUrl (null when absent or unparseable). */
export const cdpPortOf = (url: string | null): number | null => {
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
};

/**
 * Where chrome-devtools-mcp should attach: the active managed launch port if a
 * managed browser is live, otherwise the configured launch.defaultPort.
 */
export const expectedCdpPort = (
  managedPorts: readonly { readonly port: number }[],
  defaultPort: number,
): number => managedPorts[0]?.port ?? defaultPort;
