import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/webview',
    emptyOutDir: false,
    lib: {
      entry: 'webview/index.html',
      formats: ['es']
    }
  }
});

