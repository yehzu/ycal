import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
};

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string };
const appVersion = JSON.stringify(pkg.version);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    define: {
      __APP_VERSION__: appVersion,
    },
    plugins: [react()],
  },
});
