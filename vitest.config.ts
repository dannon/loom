import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Electron belongs to app/, not to the root package these tests run
      // from, so "electron" resolves differently in a test than it does in the
      // app/src/main module under test -- which silently defeats
      // vi.mock("electron"). Pin both to one id that always resolves; see the
      // header of tests/stubs/electron.ts.
      electron: fileURLToPath(new URL("./tests/stubs/electron.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "web/**/*.test.ts", "extensions/**/*.test.ts"],
  },
});
