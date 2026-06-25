import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Renderer (the React UI) lives in renderer/. base must be relative ('./') so the built assets load from
// file:// inside the packaged app. Dev server on a fixed port the main process waits for.
export default defineConfig({
  root: path.join(__dirname, 'renderer'),
  base: './',
  plugins: [react()],
  server: { port: 5273, strictPort: true },
  build: { outDir: path.join(__dirname, 'renderer-dist'), emptyOutDir: true },
});
