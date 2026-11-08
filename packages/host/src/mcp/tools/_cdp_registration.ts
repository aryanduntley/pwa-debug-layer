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
 * The managed launches whose debug port still answers. The launch registry is
 * persisted (launches.json) across host restarts, so its records include
 * browsers closed long ago; anything that reasons about the "active" browser
 * must filter through this first. Each distinct port is probed once; a probe
 * that throws counts as dead. Order (newest-last) is preserved.
 */
export const liveManagedPorts = async <T extends { readonly port: number }>(
  ports: readonly T[],
  probe: (port: number) => Promise<boolean>,
): Promise<readonly T[]> => {
  const distinct = [...new Set(ports.map((p) => p.port))];
  const live = new Set(
    (
      await Promise.all(
        distinct.map(async (port) => ((await probe(port).catch(() => false)) ? port : null)),
      )
    ).filter((p): p is number => p !== null),
  );
  return Object.freeze(ports.filter((p) => live.has(p.port)));
};

/**
 * Where chrome-devtools-mcp should attach: the most recent live managed launch
 * port (the registry is newest-last), otherwise the configured
 * launch.defaultPort. Callers pass ports already filtered by liveManagedPorts.
 */
export const expectedCdpPort = (
  managedPorts: readonly { readonly port: number }[],
  defaultPort: number,
): number => managedPorts[managedPorts.length - 1]?.port ?? defaultPort;
