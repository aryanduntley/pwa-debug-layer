export const bootstrap = (): void => {
  chrome.runtime.onInstalled.addListener((details) => {
    console.log('[pwa-debug/sw] installed:', details.reason);
  });
  console.log('[pwa-debug/sw] up; native-messaging connect placeholder');
};

bootstrap();
