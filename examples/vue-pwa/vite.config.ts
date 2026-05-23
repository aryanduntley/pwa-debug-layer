import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Port 5174 so this can run alongside the React fixture (5173).
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    strictPort: false,
  },
});
