import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["node_modules/**", ".claude/**"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "convex/**/*.test.ts", "scripts/**/*.test.mjs"],
    server: { deps: { inline: ["convex-test"] } },
    setupFiles: ["tests/setupBilling.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
