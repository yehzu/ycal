import type { YCalApi } from './index';

declare global {
  interface Window {
    ycal: YCalApi;
  }
}

export {};
