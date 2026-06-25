import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        sidebar: resolve(__dirname, 'src/sidebar-entry.tsx'),
        fullview: resolve(__dirname, 'src/fullview-entry.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        chunkFileNames: '[name].js',
      },
    },
    cssCodeSplit: true,
  },
  define: {
    'process.env': {},
  },
});
