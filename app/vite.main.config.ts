import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    // Orbit and the root project each install their own pi-ai, so a bare
    // `@earendil-works/pi-ai` import resolves to app/node_modules while
    // pi-coding-agent's resolves to the root copy. Two copies mean two module
    // instances and two sets of module state -- which silently breaks pi's
    // bundled-OAuth registration (see oauth-handler): Orbit would register the
    // flows on one instance while ModelRuntime drove the other, and sign-in
    // fell back to the variable-specifier import that no bundler can resolve.
    dedupe: ["@earendil-works/pi-ai"],
  },
});
