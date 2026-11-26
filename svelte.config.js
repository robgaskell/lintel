import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  preprocess: vitePreprocess(),
  vitePlugin: {
    // Runes for our code only, so legacy-mode Svelte packages still compile.
    dynamicCompileOptions({ filename }) {
      if (!filename.includes('node_modules')) return { runes: true };
    },
  },
};
