import type { YCalApi } from './index';

declare global {
  interface Window {
    ycal: YCalApi;
  }
  // Injected at build time from package.json via electron.vite.config.ts.
  const __APP_VERSION__: string;
}

export {};
