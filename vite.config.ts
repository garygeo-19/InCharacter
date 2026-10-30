import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// host 0.0.0.0 so a phone on the same Wi-Fi can open the dev server (§12 M0).
export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
