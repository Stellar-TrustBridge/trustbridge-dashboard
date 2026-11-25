import "server-only";

/**
 * Statistics snapshot for validation
 */
export interface StatsSnapshot {
  timestamp: Date;
  totalContributors: number;
  readyCount: number;
  lowReserveCount: number;
  notReadyCount: number;
}

/**
 * Validation result for incremental stats
 */
export interface StatsValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  previousSnapshot?: StatsSnapshot;
  currentSnapshot: StatsSnapshot;
}

/**
 * Validates that current stats represent valid incremental changes
 * from a previous snapshot
 */
export function validateIncrementalStats(
  previous: StatsSnapshot | null,
  current: StatsSnapshot
): StatsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate current snapshot consistency
  const sum = current.readyCount + current.lowReserveCount + current.notReadyCount;
  if (sum !== current.totalContributors) {
    errors.push(
      `Total contributors (${current.totalContributors}) does not equal sum of statuses (${sum})`
    );
  }

  // Validate counts are non-negative
  if (current.totalContributors < 0) {
    errors.push("Total contributors cannot be negative");
  }
  if (current.readyCount < 0) {
    errors.push("Ready count cannot be negative");
  }
  if (current.lowReserveCount < 0) {
    errors.push("Low reserve count cannot be negative");
  }
  if (current.notReadyCount < 0) {
    errors.push("Not ready count cannot be negative");
  }

  // If we have a previous snapshot, validate incremental changes
  if (previous) {
    // Total contributors should only increase or stay the same
    if (current.totalContributors < previous.totalContributors) {
      warnings.push(
        `Total contributors decreased from ${previous.totalContributors} to ${current.totalContributors}`
      );
    }

    // Individual counts should not go negative
    if (current.readyCount < 0 || current.lowReserveCount < 0 || current.notReadyCount < 0) {
      errors.push("Status counts cannot be negative");
    }

    // Check for logical time progression
    if (current.timestamp <= previous.timestamp) {
      warnings.push("Current timestamp should be later than previous timestamp");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    previousSnapshot: previous || undefined,
    currentSnapshot: current,
  };
}

/**
 * Creates a stats snapshot from contributor counts
 */
export function createStatsSnapshot(
  totalContributors: number,
  readyCount: number,
  timestamp: Date = new Date()
): StatsSnapshot {
  const lowReserveCount = Math.max(0, totalContributors - readyCount);
  const notReadyCount = 0; // In most cases, this is calculated as total - ready

  return {
    timestamp,
    totalContributors,
    readyCount,
    lowReserveCount,
    notReadyCount,
  };
}

/**
 * Checks if stats have been updated since a given timestamp
 */
export function hasStatsChanged(
  previous: StatsSnapshot,
  current: StatsSnapshot
): boolean {
  return (
    previous.totalContributors !== current.totalContributors ||
    previous.readyCount !== current.readyCount ||
    previous.lowReserveCount !== current.lowReserveCount ||
    previous.notReadyCount !== current.notReadyCount
  );
}

/**
 * Calculates the percentage of ready contributors
 */
export function getReadyPercentage(snapshot: StatsSnapshot): number {
  if (snapshot.totalContributors === 0) return 0;
  return (snapshot.readyCount / snapshot.totalContributors) * 100;
}

/**
 * Prometheus metric schema guards.
 *
 * These guards validate metric names, label names, and label values before
 * they are rendered into the Prometheus text exposition format. They exist to
 * prevent cardinality bombs (unbounded label value sets) and malformed
 * exposition output that would otherwise break scrapes during Wave spikes.
 *
 * Stable reason codes (documented in docs/ARCHITECTURE.md):
 *   - METRIC_NAME_EMPTY
 *   - METRIC_NAME_TOO_LONG
 *   - METRIC_NAME_INVALID
 *   - LABEL_NAME_EMPTY
 *   - LABEL_NAME_TOO_LONG
 *   - LABEL_NAME_INVALID
 *   - LABEL_NAME_RESERVED
 *   - LABEL_VALUE_TOO_LONG
 *   - LABEL_VALUE_INVALID
 *   - LABEL_CARDINALITY_EXCEEDED
 *   - DUPLICATE_LABEL_NAME
 */

/** Maximum length of a Prometheus metric name. */
export const MAX_METRIC_NAME_LENGTH = 200;
/** Maximum length of a Prometheus label name. */
export const MAX_LABEL_NAME_LENGTH = 128;
/** Maximum length of a Prometheus label value. */
export const MAX_LABEL_VALUE_LENGTH = 256;
/** Maximum number of distinct label values allowed per label name. */
export const MAX_LABEL_CARDINALITY = 100;

/** Prometheus metric name: [a-zA-Z_:][a-zA-Z0-9_:]* */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
/** Prometheus label name: [a-zA-Z_][a-zA-Z0-9_]* */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Label names reserved by the exposition format. */
const RESERVED_LABEL_NAMES = new Set(["__name__"]);

/**
 * A single validation issue with a stable reason code.
 */
export interface MetricValidationIssue {
  code: string;
  message: string;
  field: "metric" | "label";
  name?: string;
}

/**
 * Result of validating a metric schema.
 */
export interface MetricSchemaValidationResult {
  isValid: boolean;
  issues: MetricValidationIssue[];
}

/**
 * Validates a Prometheus metric name.
 */
export function validateMetricName(name: string): MetricValidationIssue[] {
  const issues: MetricValidationIssue[] = [];
  if (!name || name.length === 0) {
    issues.push({
      code: "METRIC_NAME_EMPTY",
      message: "Metric name must not be empty",
      field: "metric",
      name,
    });
    return issues;
  }
  if (name.length > MAX_METRIC_NAME_LENGTH) {
    issues.push({
      code: "METRIC_NAME_TOO_LONG",
      message: `Metric name exceeds ${MAX_METRIC_NAME_LENGTH} characters`,
      field: "metric",
      name,
    });
  }
  if (!METRIC_NAME_RE.test(name)) {
    issues.push({
      code: "METRIC_NAME_INVALID",
      message: "Metric name must match [a-zA-Z_:][a-zA-Z0-9_:]*",
      field: "metric",
      name,
    });
  }
  return issues;
}

/**
 * Validates a Prometheus label name.
 */
export function validateLabelName(name: string): MetricValidationIssue[] {
  const issues: MetricValidationIssue[] = [];
  if (!name || name.length === 0) {
    issues.push({
      code: "LABEL_NAME_EMPTY",
      message: "Label name must not be empty",
      field: "label",
      name,
    });
    return issues;
  }
  if (name.length > MAX_LABEL_NAME_LENGTH) {
    issues.push({
      code: "LABEL_NAME_TOO_LONG",
      message: `Label name exceeds ${MAX_LABEL_NAME_LENGTH} characters`,
      field: "label",
      name,
    });
  }
  if (!LABEL_NAME_RE.test(name)) {
    issues.push({
      code: "LABEL_NAME_INVALID",
      message: "Label name must match [a-zA-Z_][a-zA-Z0-9_]*",
      field: "label",
      name,
    });
  }
  if (RESERVED_LABEL_NAMES.has(name)) {
    issues.push({
      code: "LABEL_NAME_RESERVED",
      message: `Label name "${name}" is reserved`,
      field: "label",
      name,
    });
  }
  return issues;
}

/**
 * Validates a Prometheus label value.
 */
export function validateLabelValue(name: string, value: string): MetricValidationIssue[] {
  const issues: MetricValidationIssue[] = [];
  if (typeof value !== "string") {
    issues.push({
      code: "LABEL_VALUE_INVALID",
      message: "Label value must be a string",
      field: "label",
      name,
    });
    return issues;
  }
  if (value.length > MAX_LABEL_VALUE_LENGTH) {
    issues.push({
      code: "LABEL_VALUE_TOO_LONG",
      message: `Label value for "${name}" exceeds ${MAX_LABEL_VALUE_LENGTH} characters`,
      field: "label",
      name,
    });
  }
  // Reject control characters that would break the exposition format.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    issues.push({
      code: "LABEL_VALUE_INVALID",
      message: `Label value for "${name}" contains control characters`,
      field: "label",
      name,
    });
  }
  return issues;
}

/**
 * Validates a full metric schema: name plus label set, including per-label
 * cardinality limits to prevent cardinality bombs.
 */
export function validateMetricSchema(
  name: string,
  labels: Record<string, string> = {}
): MetricSchemaValidationResult {
  const issues: MetricValidationIssue[] = [...validateMetricName(name)];
  const seen = new Set<string>();

  for (const [labelName, labelValue] of Object.entries(labels)) {
    if (seen.has(labelName)) {
      issues.push({
        code: "DUPLICATE_LABEL_NAME",
        message: `Duplicate label name "${labelName}"`,
        field: "label",
        name: labelName,
      });
    }
    seen.add(labelName);
    issues.push(...validateLabelName(labelName));
    issues.push(...validateLabelValue(labelName, labelValue));
  }

  return { isValid: issues.length === 0, issues };
}

/**
 * Enforces a cardinality budget across a batch of label value sets.
 * Returns issues for any label name whose distinct value count exceeds
 * MAX_LABEL_CARDINALITY.
 */
export function validateLabelCardinality(
  labelSets: Array<Record<string, string>>
): MetricValidationIssue[] {
  const valuesByName = new Map<string, Set<string>>();
  for (const labels of labelSets) {
    for (const [labelName, labelValue] of Object.entries(labels)) {
      let set = valuesByName.get(labelName);
      if (!set) {
        set = new Set<string>();
        valuesByName.set(labelName, set);
      }
      set.add(labelValue);
    }
  }

  const issues: MetricValidationIssue[] = [];
  for (const [labelName, values] of valuesByName) {
    if (values.size > MAX_LABEL_CARDINALITY) {
      issues.push({
        code: "LABEL_CARDINALITY_EXCEEDED",
        message: `Label "${labelName}" has ${values.size} distinct values, exceeding limit of ${MAX_LABEL_CARDINALITY}`,
        field: "label",
        name: labelName,
      });
    }
  }
  return issues;
}
