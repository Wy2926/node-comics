import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {outDir: '../app/admin_web/dist', emptyOutDir: true},
  server: {proxy: {'/v1': process.env.ADMIN_API_ORIGIN || 'http://127.0.0.1:18088'}},
});
