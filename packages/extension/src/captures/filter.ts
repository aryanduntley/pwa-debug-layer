const INTERNAL_LOG_PREFIX = '[pwa-debug/';

const EXTENSION_FRAME_RE = /^\s*at .*chrome-extension:\/\//;

export const isInternalLog = (args: readonly unknown[]): boolean => {
  if (args.length === 0) return false;
  const first = args[0];
  return typeof first === 'string' && first.startsWith(INTERNAL_LOG_PREFIX);
};

export const stripExtensionFrames = (stack: string): string => {
  const lines = stack.split('\n');
  const headerSkipped = lines.slice(1);
  let firstUserIdx = -1;
  for (let i = 0; i < headerSkipped.length; i++) {
    const line = headerSkipped[i]!;
    if (!EXTENSION_FRAME_RE.test(line)) {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) return headerSkipped.join('\n');
  return headerSkipped.slice(firstUserIdx).join('\n');
};
