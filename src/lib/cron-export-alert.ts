import "server-only";

import { StructuredLogger } from "@/lib/logger";
import type { CronExportResult } from "@/lib/cron-export";

const logger = new StructuredLogger("cron-export-alert");

const ALERT_TIMEOUT_MS = 5_000;

/**
 * Stable reason codes for partial-export cleanup failures.
 *
 * These are surfaced through the existing alerting path so operators can
 * triage leftover artifacts without parsing free-form error text.
 *
 *   - `cleanup_local_failed`  — could not remove the partial local file
 *   - `cleanup_storage_failed` — could not remove the partial object-storage object
 *   - `cleanup_unknown_failed` — cleanup failed for an unrecognized target
 */
export type CronExportCleanupReasonCode =
  | "cleanup_local_failed"
  | "cleanup_storage_failed"
  | "cleanup_unknown_failed";

export interface CronExportAlertPayload {
  source: "trustbridge-cron-export";
  status: "error";
  error: string;
  startedAt: string;
  durationMs: number;
  /** NODE_ENV value at dispatch time — helps triage staging vs production alerts. */
  environment: string;
  /** Optional: PagerDuty routing key from CRON_EXPORT_ALERT_PAGERDUTY_KEY. */
  routing_key?: string;
  /** Formatted text for Slack-style webhooks. */
  text?: string;
  /** PagerDuty event action (always "trigger" for failures). */
  event_action?: "trigger";
  /** Stable reason code when the failure is a partial-file cleanup failure. */
  reason_code?: CronExportCleanupReasonCode;
}

/**
 * Redact PII and secrets from alert text before it leaves the process.
 *
 * Masks:
 *   - Stellar G-addresses (`G` + 55 base32 chars) → `G...<last4>`
 *   - API-key-style secrets (`tb_…`, `sk-…`/`sk_…`, Slack `xox…` tokens)
 *     → `[redacted-secret]`
 *   - `Bearer <token>` credential values → `Bearer [redacted]`
 *
 * Pure function — safe to unit test and reuse in other alert paths.
 */
export function redactAlertText(value: string): string {
  return value
    .replace(/\bG[A-Z2-7]{55}\b/g, (address) => `${address.slice(0, 5)}...${address.slice(-4)}`)
    .replace(
      /\b(tb_[A-Za-z0-9_-]{8,}|sk[-_][A-Za-z0-9_-]{8,}|xox[bap]-[A-Za-z0-9-]+)\b/g,
      "[redacted-secret]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*\b/g, "Bearer [redacted]");
}

/**
 * Fire an outbound failure-alert webhook when the cron export fails.
 *
 * Destination: `CRON_EXPORT_ALERT_WEBHOOK_URL` env var.
 * If the var is not set the function is a no-op.
 *
 * The POST is fire-and-forget with a 5-second abort timeout.
 * A delivery failure is logged but never re-throws — the alert mechanism must
 * not interfere with the export result or the caller's error handling.
 *
 * @param result  The failed CronExportResult from runCronExport().
 */
export async function sendCronExportAlert(
  result: CronExportResult
): Promise<void> {
  const webhookUrl = process.env.CRON_EXPORT_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const error = redactAlertText(result.error ?? "Unknown export failure");
  const environment = process.env.NODE_ENV ?? "unknown";

  const payload: CronExportAlertPayload = {
    source: "trustbridge-cron-export",
    status: "error",
    error,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    environment,
    // Slack incoming webhooks use the `text` field for the message body.
    text: `🚨 TrustBridge cron export failed (${environment})\nError: ${error}\nStarted: ${result.startedAt} — took ${result.durationMs}ms`,
  };

  // PagerDuty Events API v2 requires a routing_key and event_action.
  const pdKey = process.env.CRON_EXPORT_ALERT_PAGERDUTY_KEY?.trim();
  if (pdKey) {
    payload.routing_key = pdKey;
    payload.event_action = "trigger";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("cron_export_alert_non_ok", {
        webhookUrl,
        status: response.status,
      });
    } else {
      logger.info("cron_export_alert_sent", { webhookUrl, status: response.status });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // AbortError = timeout; log as warn, not error — the alert delivery
    // failure is secondary to the original export failure.
    logger.warn("cron_export_alert_failed", { webhookUrl, error: message });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Report a partial-export cleanup failure through the existing alerting path.
 *
 * Reuses `sendCronExportAlert` so operators get the same webhook/PagerDuty
 * routing as ordinary export failures, but tags the payload with a stable
 * `reason_code` so leftover artifacts are distinguishable from the original
 * upload failure. Never throws — cleanup reporting must not mask the export
 * result.
 *
 * @param result     The failed CronExportResult from runCronExport().
 * @param reasonCode Stable cleanup reason code (see CronExportCleanupReasonCode).
 * @param detail     Optional human-readable detail (already redacted here).
 */
export async function sendCronExportCleanupAlert(
  result: CronExportResult,
  reasonCode: CronExportCleanupReasonCode,
  detail?: string
): Promise<void> {
  const webhookUrl = process.env.CRON_EXPORT_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  const environment = process.env.NODE_ENV ?? "unknown";
  const baseError = redactAlertText(result.error ?? "Unknown export failure");
  const cleanupDetail = detail ? redactAlertText(detail) : undefined;
  const error = cleanupDetail
    ? `${baseError} [${reasonCode}: ${cleanupDetail}]`
    : `${baseError} [${reasonCode}]`;

  const payload: CronExportAlertPayload = {
    source: "trustbridge-cron-export",
    status: "error",
    error,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    environment,
    reason_code: reasonCode,
    text: `🚨 TrustBridge cron export cleanup failed (${environment})\nReason: ${reasonCode}\nError: ${error}\nStarted: ${result.startedAt} — took ${result.durationMs}ms`,
  };

  const pdKey = process.env.CRON_EXPORT_ALERT_PAGERDUTY_KEY?.trim();
  if (pdKey) {
    payload.routing_key = pdKey;
    payload.event_action = "trigger";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("cron_export_cleanup_alert_non_ok", {
        webhookUrl,
        status: response.status,
        reasonCode,
      });
    } else {
      logger.info("cron_export_cleanup_alert_sent", {
        webhookUrl,
        status: response.status,
        reasonCode,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("cron_export_cleanup_alert_failed", {
      webhookUrl,
      error: message,
      reasonCode,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Ping a dead-man's-switch / healthcheck URL after a successful export run.
 *
 * Destination: `CRON_EXPORT_PING_URL` env var (e.g. healthchecks.io check-in URL).
 * A missed ping on the external service triggers an alert there.
 * No-op when the var is not set.
 */
export async function pingCronExportSuccess(): Promise<void> {
  const pingUrl = process.env.CRON_EXPORT_PING_URL?.trim();
  if (!pingUrl) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);

  try {
    const response = await fetch(pingUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("cron_export_ping_non_ok", { pingUrl, status: response.status });
    } else {
      logger.info("cron_export_ping_sent", { pingUrl });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("cron_export_ping_failed", { pingUrl, error: message });
  } finally {
    clearTimeout(timeoutId);
  }
}
