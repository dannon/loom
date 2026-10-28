// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Deployed to GitHub Pages under the loom repo: https://galaxyproject.github.io/orbit/
export default defineConfig({
  site: "https://galaxyproject.github.io",
  base: "/orbit",
  vite: {
    plugins: [tailwindcss()],
  },
});
