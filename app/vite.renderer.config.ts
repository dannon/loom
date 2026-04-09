import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  server: {
    port: 5199,
    strictPort: false,
  },
});
