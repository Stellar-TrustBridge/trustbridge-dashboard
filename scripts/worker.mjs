#!/usr/bin/env node
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

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
