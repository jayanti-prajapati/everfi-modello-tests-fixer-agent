import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server proxies the orchestrator API (npm run orchestrate -- --serve) on 4317.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4317' } },
});
