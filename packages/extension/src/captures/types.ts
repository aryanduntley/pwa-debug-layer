export type CaptureMeta = {
  readonly ts: number;
  readonly frameUrl: string;
  readonly frameKey: string;
};

export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace';

export type ConsoleCapturedEvent = CaptureMeta & {
  readonly kind: 'console';
  readonly level: ConsoleLevel;
  readonly args: readonly unknown[];
  readonly stack?: string;
};

export type CapturedEvent = ConsoleCapturedEvent;
