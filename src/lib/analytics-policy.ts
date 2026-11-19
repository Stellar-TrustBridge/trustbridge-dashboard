export type EventType =
  | "registration_created"
  | "registration_updated"
  | "recheck_completed"
  | "batch_recheck_started"
  | "csv_exported"
  | "soroban_mirror_completed"
  | "dispute_opened"
  | "dispute_closed";

export type AnalyticsPropertyRuleType =
  | "number"
  | "boolean"
  | "string"
  | "hashedId"
  | "stringList"
  | "enum";

export interface AnalyticsPropertyRule {
  type: AnalyticsPropertyRuleType;
  values?: readonly string[];
  maxLength?: number;
}

export const ANALYTICS_EVENT_SCHEMA: Readonly<
  Record<EventType, Readonly<Record<string, AnalyticsPropertyRule>>>
> = {
  registration_created: {
    userId: { type: "hashedId" },
  },
  registration_updated: {
    userId: { type: "hashedId" },
    fieldsChanged: {
      type: "stringList",
      values: ["profile", "preferences", "readiness", "githubUsername", "name"],
    },
  },
  recheck_completed: {
    totalChecked: { type: "number" },
    changed: { type: "number" },
    durationMs: { type: "number" },
  },
  batch_recheck_started: {
    totalRegistrations: { type: "number" },
    initiatedBy: { type: "hashedId" },
  },
  csv_exported: {
    rowCount: { type: "number" },
    triggeredBy: { type: "hashedId" },
  },
  soroban_mirror_completed: {
    success: { type: "boolean" },
    durationMs: { type: "number" },
  },
  dispute_opened: {
    userId: { type: "hashedId" },
    disputeId: { type: "hashedId" },
    registrationId: { type: "hashedId" },
    actorRole: { type: "enum", values: ["maintainer", "contributor"] },
    hasProof: { type: "boolean" },
  },
  dispute_closed: {
    userId: { type: "hashedId" },
    disputeId: { type: "hashedId" },
    status: { type: "enum", values: ["VALIDATED", "REJECTED"] },
  },
};

export const ANALYTICS_IDENTIFY_SCHEMA: Readonly<
  Record<string, AnalyticsPropertyRule>
> = {
  maintainerOrgId: { type: "string", maxLength: 128 },
  githubUsername: { type: "hashedId" },
  role: { type: "string", maxLength: 64 },
};

export const ANALYTICS_EVENT_TYPES = Object.keys(
  ANALYTICS_EVENT_SCHEMA,
) as EventType[];

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

export function parseAnalyticsBool(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined;
}

export function isAnalyticsEnabled(): boolean {
  const optOut =
    parseAnalyticsBool(process.env.ANALYTICS_OPT_OUT) ??
    parseAnalyticsBool(process.env.NEXT_PUBLIC_ANALYTICS_OPT_OUT);
  if (optOut === true) return false;

  const configured =
    parseAnalyticsBool(process.env.ANALYTICS_ENABLED) ??
    parseAnalyticsBool(process.env.NEXT_PUBLIC_ANALYTICS_ENABLED) ??
    parseAnalyticsBool(process.env.FEATURE_FLAG_ANALYTICS) ??
    parseAnalyticsBool(process.env.NEXT_PUBLIC_FEATURE_FLAG_ANALYTICS);

  return configured !== false;
}

const SENSITIVE_KEY = /(email|token|secret|password|passwd|note|address|publickey|seed|phone|cookie|authorization)/i;
const EMAIL_VALUE = /@[^\s@]+\.[^\s@]+/;
const STELLAR_VALUE = /\b[GS][A-Z2-7]{55}\b/i;
const TOKEN_VALUE = /(gh[pousr]_|github_pat_|sk-[a-z0-9]{16}|bearer\s+)/i;

export function hashIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  const salt = process.env.ANALYTICS_HASH_SALT?.trim() || "trustbridge-analytics-v1";
  const bytes = new TextEncoder().encode(`${salt}:${normalized}`);
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index++) {
    high ^= bytes[index];
    low ^= bytes[index];
    high = Math.imul(high, 0x01000193) >>> 0;
    low = Math.imul(low, 0x85ebca6b) >>> 0;
  }
  return `anon_${high.toString(16).padStart(8, "0")}${low
    .toString(16)
    .padStart(8, "0")}`;
}

function looksSensitive(value: string): boolean {
  return (
    EMAIL_VALUE.test(value) ||
    STELLAR_VALUE.test(value) ||
    TOKEN_VALUE.test(value)
  );
}

function sanitizeValue(
  value: unknown,
  rule: AnalyticsPropertyRule,
): string | number | boolean | string[] | null {
  if (rule.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  if (rule.type === "boolean") {
    return typeof value === "boolean" ? value : null;
  }

  if (rule.type === "stringList") {
    if (!Array.isArray(value)) return null;
    const allowed = new Set(rule.values ?? []);
    const values = value
      .filter((item): item is string => typeof item === "string")
      .filter((item) => allowed.has(item))
      .slice(0, 20);
    return values.length > 0 ? values : null;
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > (rule.maxLength ?? 256)) return null;
  if (looksSensitive(trimmed)) return null;
  if (rule.type === "enum" && !(rule.values ?? []).includes(trimmed)) return null;
  return rule.type === "hashedId" ? hashIdentifier(trimmed) : trimmed;
}

function sanitizeProperties(
  properties: Record<string, unknown> | undefined,
  schema: Readonly<Record<string, AnalyticsPropertyRule>>,
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  if (!properties) return result;

  for (const [key, rule] of Object.entries(schema)) {
    if (!(key in properties)) continue;
    if (SENSITIVE_KEY.test(key) && rule.type !== "hashedId") continue;
    const sanitized = sanitizeValue(properties[key], rule);
    if (sanitized !== null) result[key] = sanitized;
  }
  return result;
}

export function sanitizeAnalyticsProperties(
  event: EventType,
  properties?: Record<string, unknown>,
): Record<string, string | number | boolean | string[]> {
  return sanitizeProperties(properties, ANALYTICS_EVENT_SCHEMA[event] ?? {});
}

export interface SanitizedIdentify {
  distinctId: string;
  properties: Record<string, string | number | boolean | string[]>;
}

export function sanitizeIdentify(
  userId: string,
  properties?: Record<string, unknown>,
): SanitizedIdentify | null {
  if (typeof userId !== "string" || !userId.trim() || userId === "anonymous") {
    return null;
  }
  return {
    distinctId: hashIdentifier(userId),
    properties: sanitizeProperties(properties, ANALYTICS_IDENTIFY_SCHEMA),
  };
}
