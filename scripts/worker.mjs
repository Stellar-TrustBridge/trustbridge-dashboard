#!/usr/bin/env node
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/worker.mjs [options]

Options:
  -h, --help  Show this help message and exit

Runs the Trustbridge queue worker. TypeScript modules are loaded via jiti.`);
  process.exit(0);
}

const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: {
    "@": fileURLToPath(new URL("../src", import.meta.url)),
  },
});

const { runWorker } = await jiti.import("../src/lib/queue-worker.ts");
runWorker().catch((err) => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
