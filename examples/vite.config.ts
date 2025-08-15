import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        'placeholder-1': 'placeholder-1.html',
        'placeholder-2': 'placeholder-2.html'
      }
    }
  },
  server: {
    open: '/index.html'
  }
});