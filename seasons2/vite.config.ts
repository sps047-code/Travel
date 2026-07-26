import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Served from https://<user>.github.io/Travel/ eventually, so the base path
// matches the current app. Adjust if the deploy path changes.
export default defineConfig({
  base: '/Travel/',
  plugins: [svelte()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
