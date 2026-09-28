// Not in tsconfig.node.json: Vitest 2 bundles its own Vite types, which clash with the app's Vite 6.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
