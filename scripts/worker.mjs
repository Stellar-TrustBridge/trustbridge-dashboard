#!/usr/bin/env node
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: {
    "@": fileURLToPath(new URL("../src", import.meta.url)),
  },
});

const { runWorker } = await jiti.import("../src/lib/queue-worker.ts");
const { processSorobanOutbox } = await jiti.import(
  "../src/lib/soroban-outbox.ts",
);

const OUTBOX_INTERVAL_MS = Number(
  process.env.SOROBAN_OUTBOX_INTERVAL_MS ?? 15_000,
);

let outboxTimer = null;
let outboxRunning = false;

async function runOutboxTick() {
  if (outboxRunning) return;
  outboxRunning = true;
  try {
    await processSorobanOutbox();
  } catch (err) {
    console.error("Soroban outbox tick failed:", err);
  } finally {
    outboxRunning = false;
  }
}

function startOutboxLoop() {
  if (outboxTimer) return;
  outboxTimer = setInterval(runOutboxTick, OUTBOX_INTERVAL_MS);
  if (typeof outboxTimer.unref === "function") outboxTimer.unref();
  void runOutboxTick();
}

function stopOutboxLoop() {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}

function shutdown(signal) {
  console.log(`Received ${signal}, stopping worker...`);
  stopOutboxLoop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startOutboxLoop();

runWorker().catch((err) => {
  console.error("Fatal worker error:", err);
  stopOutboxLoop();
  process.exit(1);
});
