import { z } from 'zod';
import {
  okResponse,
  errorResponse,
  type ToolContext,
  type ToolDef,
  type ToolResponse,
} from '../tool_registry.js';
import { resolveTarget } from './target_resolution.js';
import { correlatePopupFailures } from '../../popup_failures/correlate.js';
import type { PopupFailureReport } from '@pwa-debug/shared';

const inputSchema = {
  extension_id: z.string().min(1).optional(),
  include_all: z.boolean().optional(),
  include_nested: z.boolean().optional(),
  popup_id: z.string().min(1).optional(),
};

export const popupFailuresHandler = async (
  args: z.infer<z.ZodObject<typeof inputSchema>>,
  ctx: ToolContext,
): Promise<ToolResponse> => {
  const target = resolveTarget(ctx, args.extension_id);
  if (!target.ok) {
    return errorResponse(target.error, [
      'Call host_status to see activeConnections. If empty, ensure host_register_extension has been called for the target extension and the user has reloaded the extension.',
    ]);
  }

  const captures = ctx.capturesRegistry.get(target.extensionId);
  if (captures === undefined) {
    return okResponse(
      { reports: [] },
      [
        `Extension ${target.extensionId} is connected but no captures-flavor events have arrived yet at the host. Open a library popup/widget (e.g. a wallet-connect modal) and trigger a connect attempt, then retry.`,
      ],
    );
  }

  const reports: PopupFailureReport[] = correlatePopupFailures({
    popups: captures.tail('library_popup'),
    consoleEvents: captures.tail('console'),
    networkEvents: captures.tail('network'),
    errorEvents: captures.tail('page_error'),
    now: Date.now(),
    ...(args.include_all !== undefined ? { includeAll: args.include_all } : {}),
    ...(args.include_nested !== undefined ? { includeNested: args.include_nested } : {}),
    ...(args.popup_id !== undefined ? { popupId: args.popup_id } : {}),
  });

  const scope = args.include_nested === true ? 'primary + nested' : 'primary-only';
  const nextSteps: string[] = [
    `Returned ${reports.length} PopupFailureReport(s) for extension ${target.extensionId}; scope=${scope}. Each report names a popup (popupId, library, detection, frameKey, role=primary|nested, parentPopupId), its reason (in-widget failure text > uncaught page error > console error > network error), any in-widget alerts, the open window {from, to, open}, and the uncaught errors[] (window error/unhandledrejection) + console errors + failed network requests captured during that window (matched by frameKey). By DEFAULT only PRIMARY popups are reported — one failure report per logical widget, so a component-heavy modal (e.g. Reown/WalletConnect) yields a single report rather than one per nested component. Use this to tell the user 'the <library> modal showed an error: <reason>' with linked evidence.`,
  ];
  if (reports.length === 0) {
    nextSteps.push(
      'No primary popups with a failure signal. Pass include_all=true to list every tracked (primary) popup window even without a failure, include_nested=true to also report nested component popups, or confirm a popup actually appeared via popup_tail.',
    );
  } else {
    nextSteps.push(
      'For full console/network detail beyond the correlated subset, page console_tail / network_tail with filter.since around a report.window.from.',
    );
  }

  return okResponse({ reports }, nextSteps);
};

export const popupFailuresTool: ToolDef<typeof inputSchema> = Object.freeze({
  name: 'popup_failures',
  description:
    "Surface auth/connect FAILURES from library popups for a target extension. Correlates each tracked popup's in-widget failure (PopupState.failure/alerts captured by popup_tail's producer) with the console errors and failed network requests (fetch/xhr phase 'error' | status>=400 | status===0, websocket 'error') that fired during that popup's open window, matched by frameKey. Returns { reports: PopupFailureReport[] }, each: { popupId, library, detection, frameKey, role=primary|nested, parentPopupId, reason?, alerts?, window{from,to,open}, console[{level,text,ts,sequenceNumber}], network[{kind,url?,method?,status?,phase?,ts,sequenceNumber}] }. reason precedence = in-widget failure text > first uncaught page error (window error/unhandledrejection) > first console error (structured-logger args unwrapped to msg/message) > network error. Each report also carries errors[] (uncaught page errors in the window). By DEFAULT only PRIMARY popups WITH a failure signal are returned — one report per logical widget, so a component-heavy modal (e.g. a Reown/WalletConnect modal of ~hundreds of nested web components) yields ONE failure report, not hundreds. The primary's window already aggregates the whole widget's console/network errors by frameKey. Pass include_nested=true to also report nested component popups (each carries parentPopupId), include_all=true to include primary windows without a failure signal, or popup_id to filter to one. With no extension_id, targets the single connected NMH (errors if zero or multiple). Read-only.",
  inputSchema,
  handler: popupFailuresHandler,
});
