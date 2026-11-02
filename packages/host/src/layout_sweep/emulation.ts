import type { LayoutColorScheme, LayoutRect, LayoutViewportSpec } from '@pwa-debug/shared';
import type { CdpClient } from '../cdp_client/types.js';

/**
 * CDP emulation for the sweep, on the job's own client. Emulation is scoped
 * to that client's session, so closing the client also undoes it; reset is
 * called explicitly anyway so the page is restored before the client closes.
 */

/** Set (or clear, for null = the device's own size) the device-metrics override. */
export const applyViewport = async (
  client: CdpClient,
  viewport: LayoutViewportSpec | null,
): Promise<void> => {
  if (viewport === null) {
    await client.send('Emulation.clearDeviceMetricsOverride');
    return;
  }
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.dpr,
    mobile: viewport.mobile,
  });
};

export const applyColorScheme = async (
  client: CdpClient,
  scheme: LayoutColorScheme,
): Promise<void> => {
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme === 'no-preference' ? '' : scheme }],
  });
};

/** Drop every override the sweep set. Best effort: a closed page has nothing to restore. */
export const resetEmulation = async (client: CdpClient): Promise<void> => {
  await client.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  await client.send('Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => undefined);
};

/** Reload the page and wait for its load event (or the timeout). */
export const reloadAndWait = (client: CdpClient, timeoutMs: number): Promise<'complete' | 'loading'> =>
  new Promise((resolve) => {
    let off: () => void = () => undefined;
    const timer = setTimeout(() => {
      off();
      resolve('loading');
    }, timeoutMs);
    off = client.on('Page.loadEventFired', () => {
      clearTimeout(timer);
      off();
      resolve('complete');
    });
    client.send('Page.reload', { ignoreCache: false }).catch(() => {
      clearTimeout(timer);
      off();
      resolve('loading');
    });
  });

const CLIP_MARGIN = 16;

/** Screenshot clip around a viewport-relative rect, in page coordinates. */
export const clipFor = (
  rect: LayoutRect,
  scroll: { readonly x: number; readonly y: number },
): { x: number; y: number; width: number; height: number; scale: number } => {
  const x = Math.max(0, rect.x + scroll.x - CLIP_MARGIN);
  const y = Math.max(0, rect.y + scroll.y - CLIP_MARGIN);
  return {
    x,
    y,
    width: Math.max(1, rect.width + CLIP_MARGIN * 2),
    height: Math.max(1, Math.min(rect.height + CLIP_MARGIN * 2, 2000)),
    scale: 1,
  };
};

/** PNG (base64) of a clip, or null when the capture fails. */
export const captureClip = async (
  client: CdpClient,
  clip: ReturnType<typeof clipFor>,
): Promise<string | null> => {
  try {
    const r = (await client.send('Page.captureScreenshot', {
      format: 'png',
      clip,
      captureBeyondViewport: true,
    })) as { data?: unknown };
    return typeof r.data === 'string' ? r.data : null;
  } catch {
    return null;
  }
};
