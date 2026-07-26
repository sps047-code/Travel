import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Served from https://<user>.github.io/Travel/ eventually, so the base path
// matches the current app. Adjust if the deploy path changes.
export default defineConfig({
  // Preview build lives at /Travel/v2/ so it sits beside the live app untouched.
  base: '/Travel/v2/',
  plugins: [svelte()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
