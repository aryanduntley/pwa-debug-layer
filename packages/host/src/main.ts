import type { AnyProtocolMessage } from '@pwa-debug/shared/protocol';

export const main = (): void => {
  const handshake: AnyProtocolMessage = { kind: 'ping', id: 'boot' };
  console.log('[pwa-debug-host] up; protocol handshake stub:', handshake);
};

main();
