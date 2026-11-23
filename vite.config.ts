import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = Number(process.env.PORT ?? 4317);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    // 开发时网页跑在 5173，接口转发到看板服务器
    proxy: { '/api': { target: `http://localhost:${API_PORT}` } },
  },
});
