/**
 * Temp-profile cleanup registry (pure closure).
 *
 * sandbox-temp profile dirs are registered here; cleanupAll removes them on
 * host shutdown. removeDir is injected so this is testable; node_deps wires the
 * real fs.rmSync + the SIGINT/SIGTERM/exit handlers. Best-effort: per-dir
 * removal errors are swallowed so one bad dir cannot block the rest.
 */
export type TempCleanupRegistry = {
  readonly register: (dir: string) => void;
  readonly cleanupAll: () => void;
  readonly list: () => readonly string[];
};

/** mkdtemp name prefix for sandbox-temp profile dirs (under os.tmpdir()). */
export const TEMP_PROFILE_PREFIX = 'pwa-debug-';

/**
 * Filter a directory listing (os.tmpdir() entries) down to pwa-debug sandbox-
 * temp profiles. Used at boot to detect dirs left by a previous crashed run —
 * graceful shutdown cleans its own, so survivors imply a SIGKILL/crash.
 */
export const filterTempProfileNames = (
  names: readonly string[],
): readonly string[] => names.filter((n) => n.startsWith(TEMP_PROFILE_PREFIX));

export const createTempCleanupRegistry = (deps: {
  readonly removeDir: (dir: string) => void;
}): TempCleanupRegistry => {
  const dirs = new Set<string>();
  return Object.freeze({
    register: (dir: string) => {
      dirs.add(dir);
    },
    cleanupAll: () => {
      for (const dir of dirs) {
        try {
          deps.removeDir(dir);
        } catch {
          // best-effort; a lingering temp dir is acceptable across crashes.
        }
      }
      dirs.clear();
    },
    list: () => Object.freeze([...dirs]),
  });
};
