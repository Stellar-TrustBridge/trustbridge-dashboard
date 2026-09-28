import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // tsconfig uses "jsx": "preserve" for Next.js; Vitest needs the automatic
    // runtime transform so `.tsx` component tests get `jsx-runtime` imports.
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" throws unless bundled with the "react-server" export
      // condition (which Next.js sets). Point it at its no-op twin so
      // server-only libs can be unit tested directly under Vitest/Node.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    environmentMatchGlobs: [
      ["src/**/*.test.tsx", "jsdom"],
      ["tests/**/*.test.tsx", "jsdom"],
    ],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
});
