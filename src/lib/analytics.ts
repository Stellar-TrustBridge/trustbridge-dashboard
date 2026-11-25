/**
 * Registration conversion funnel metrics.
 *
 * These counters back the Prometheus exposition served from
 * `src/app/api/metrics/` and are incremented from the registration flow in
 * `src/app/api/register/`. They exist so Wave organizers can spot registration
 * breakage (e.g. a spike in verify-fail or a drop in submit) without reading
 * individual records.
 *
 * Metric names (stable ABI for dashboards/alerts):
 *   - trustbridge_registration_checklist_start_total
 *   - trustbridge_registration_checklist_submit_total
 *   - trustbridge_registration_verify_pass_total
 *   - trustbridge_registration_verify_fail_total
 *
 * Label sets (deliberately tiny — see no-PII rules below):
 *   - `org`   : organization slug the registration belongs to (org-scope key)
 *   - `reason`: only on verify-fail; a stable reason code, never free text
 *
 * No-PII labeling rules:
 *   - Never use emails, wallet addresses, IPs, user agents, names, or any
 *     per-user identifier as a label value. Cardinality and privacy both forbid it.
 *   - `org` must be the slug from the authenticated org scope, not a raw input.
 *   - `reason` must be one of the documented reason codes below; unknown values
 *     collapse to `unknown` so malformed input cannot leak through labels.
 */

export const REGISTRATION_METRICS = {
  checklistStart: "trustbridge_registration_checklist_start_total",
  checklistSubmit: "trustbridge_registration_checklist_submit_total",
  verifyPass: "trustbridge_registration_verify_pass_total",
  verifyFail: "trustbridge_registration_verify_fail_total",
} as const;

export type RegistrationMetric =
  (typeof REGISTRATION_METRICS)[keyof typeof REGISTRATION_METRICS];

/** Stable verify-fail reason codes. Anything else is reported as `unknown`. */
export const VERIFY_FAIL_REASONS = [
  "invalid_signature",
  "expired",
  "org_mismatch",
  "malformed",
  "unknown",
] as const;

export type VerifyFailReason = (typeof VERIFY_FAIL_REASONS)[number];

export type RegistrationMetricLabels = {
  org: string;
  reason?: VerifyFailReason;
};

type Counter = { labels: RegistrationMetricLabels; value: number };

const counters = new Map<string, Counter>();

function counterKey(metric: RegistrationMetric, labels: RegistrationMetricLabels): string {
  return `${metric}|${labels.org}|${labels.reason ?? ""}`;
}

/**
 * Normalize a verify-fail reason to a documented code. Unknown or malformed
 * values collapse to `unknown` so labels stay bounded and PII-free.
 */
export function normalizeVerifyFailReason(reason: unknown): VerifyFailReason {
  if (typeof reason === "string" && (VERIFY_FAIL_REASONS as readonly string[]).includes(reason)) {
    return reason as VerifyFailReason;
  }
  return "unknown";
}

/**
 * Increment a registration funnel counter. `reason` is only honored for the
 * verify-fail metric; other metrics ignore it to keep label sets stable.
 */
export function incrementRegistrationMetric(
  metric: RegistrationMetric,
  labels: RegistrationMetricLabels,
): void {
  const normalized: RegistrationMetricLabels = {
    org: labels.org,
    ...(metric === REGISTRATION_METRICS.verifyFail
      ? { reason: normalizeVerifyFailReason(labels.reason) }
      : {}),
  };
  const key = counterKey(metric, normalized);
  const existing = counters.get(key);
  if (existing) {
    existing.value += 1;
  } else {
    counters.set(key, { labels: normalized, value: 1 });
  }
}

/**
 * Render the registration funnel counters in Prometheus text exposition format.
 * Intended to be concatenated into the `/api/metrics` response body.
 */
export function renderRegistrationMetrics(): string {
  const lines: string[] = [];
  for (const [key, counter] of counters) {
    const metric = key.split("|")[0] as RegistrationMetric;
    const labelParts = [`org="${escapeLabelValue(counter.labels.org)}"`];
    if (counter.labels.reason) {
      labelParts.push(`reason="${escapeLabelValue(counter.labels.reason)}"`);
    }
    lines.push(`${metric}{${labelParts.join(",")}} ${counter.value}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Test-only helper to reset in-memory counters between cases. */
export function resetRegistrationMetrics(): void {
  counters.clear();
}
