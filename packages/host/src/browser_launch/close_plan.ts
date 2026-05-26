/**
 * Pure close-planning for pdl_close_browser. Given the launch registry's
 * records, a target selector, and a requested session disposition, decide what
 * to do with each MATCHED managed launch — encoding the safety rules so the
 * tool can never harm an unmanaged or user-owned browser:
 *
 *  - pid === null  => we ATTACHED to an already-running browser, we did not
 *    spawn it. Never terminate someone else's process: detach-only (drop the
 *    registry record, leave the browser running).
 *  - session 'detach' => drop the registry record without terminating.
 *  - session 'discard' is honored ONLY for sandbox profiles; an 'existing'
 *    launch points at the user's real profile dir, which we must never delete,
 *    so discard is downgraded to terminate + persist (with an explanatory note).
 *
 * No effects: this is a pure decision over the records. node_deps performs the
 * actual process termination + profile removal; the tool orchestrates.
 */
import type { LaunchRecord } from './registry.js';

/** What to do with the profile/process after a close request. */
export type CloseSession = 'persist' | 'discard' | 'detach';

/** Which managed launch(es) to act on. AND-matched; empty selector matches none. */
export type CloseTarget = {
  readonly browser?: string;
  readonly port?: number;
  readonly pid?: number;
  readonly all?: boolean;
};

/** The resolved action for one matched launch. */
export type PlannedClose = {
  readonly record: LaunchRecord;
  /** terminate = stop the process WE spawned; detach = drop the record only. */
  readonly action: 'terminate' | 'detach';
  /** Remove the sandbox profile dir after a successful terminate. */
  readonly discardProfile: boolean;
  /** Present when the requested session was adjusted for safety. */
  readonly note?: string;
};

const isSandboxProfile = (r: LaunchRecord): boolean =>
  r.profileType === 'sandbox-persistent' || r.profileType === 'sandbox-temp';

/**
 * AND-match a record against the selector. `all` short-circuits true; otherwise
 * every provided field must match and at least one field must be provided (so
 * an empty target deliberately matches nothing — closing requires intent).
 */
const matchesTarget = (r: LaunchRecord, t: CloseTarget): boolean => {
  if (t.all) return true;
  let provided = false;
  if (t.pid !== undefined) {
    if (r.pid !== t.pid) return false;
    provided = true;
  }
  if (t.port !== undefined) {
    if (r.port !== t.port) return false;
    provided = true;
  }
  if (t.browser !== undefined) {
    if (r.browser !== t.browser) return false;
    provided = true;
  }
  return provided;
};

export const planClose = (
  records: readonly LaunchRecord[],
  target: CloseTarget,
  session: CloseSession,
): readonly PlannedClose[] => {
  const matched = records.filter((r) => matchesTarget(r, target));
  return Object.freeze(
    matched.map((record): PlannedClose => {
      // Attached (not spawned by us) → never kill someone else's browser.
      if (record.pid === null) {
        return Object.freeze({
          record,
          action: 'detach',
          discardProfile: false,
          ...(session === 'detach'
            ? {}
            : {
                note: 'attached launch (not spawned by pwa-debug) — detached from the registry without terminating the browser.',
              }),
        });
      }
      if (session === 'detach') {
        return Object.freeze({
          record,
          action: 'detach',
          discardProfile: false,
        });
      }
      const wantsDiscard = session === 'discard';
      const canDiscard = wantsDiscard && isSandboxProfile(record);
      return Object.freeze({
        record,
        action: 'terminate',
        discardProfile: canDiscard,
        ...(wantsDiscard && !canDiscard
          ? {
              note: "session 'discard' ignored for an 'existing'-profile launch — terminated the process but kept the user's profile dir.",
            }
          : {}),
      });
    }),
  );
};
