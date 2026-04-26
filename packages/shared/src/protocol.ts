export type HostToExtensionMessage =
  | { readonly kind: 'ping'; readonly id: string };

export type ExtensionToHostMessage =
  | { readonly kind: 'pong'; readonly id: string };

export type AnyProtocolMessage = HostToExtensionMessage | ExtensionToHostMessage;
