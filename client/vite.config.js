import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true, // reachable from a phone on the same Wi-Fi, for the mobile-layout test pass
    proxy: {
      '/api': { target: 'http://localhost:5002', changeOrigin: true },
      '/outputs': { target: 'http://localhost:5002', changeOrigin: true },
    },
  },
});
