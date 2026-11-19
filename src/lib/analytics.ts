import {
  isAnalyticsEnabled,
  sanitizeAnalyticsProperties,
  sanitizeIdentify,
  type EventType,
} from "@/lib/analytics-policy";

export type { EventType } from "@/lib/analytics-policy";

export interface AnalyticsEvent {
  type: EventType;
  timestamp: number;
  properties?: Record<string, unknown>;
}

interface AnalyticsAdapter {
  track(event: EventType, properties?: Record<string, unknown>): void;
  identify(userId: string, properties?: Record<string, unknown>): void;
  reset(): void;
}

class NoOpAdapter implements AnalyticsAdapter {
  track(): void {}
  identify(): void {}
  reset(): void {}
}

class ConsoleAdapter implements AnalyticsAdapter {
  track(event: EventType, properties?: Record<string, unknown>): void {
    if (!isAnalyticsEnabled()) return;
    console.log(`[Analytics] ${event}`, sanitizeAnalyticsProperties(event, properties));
  }

  identify(userId: string, properties?: Record<string, unknown>): void {
    if (!isAnalyticsEnabled()) return;
    const sanitized = sanitizeIdentify(userId, properties);
    if (!sanitized) return;
    console.log(`[Analytics] identify: ${sanitized.distinctId}`, sanitized.properties);
  }

  reset(): void {
    if (!isAnalyticsEnabled()) return;
    console.log("[Analytics] reset");
  }
}

class PostHogAdapter implements AnalyticsAdapter {
  private apiKey: string;
  private host: string;
  private initialized = false;

  constructor(apiKey: string, host?: string) {
    this.apiKey = apiKey;
    this.host = host || "https://app.posthog.com";
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const posthog = await import("posthog-js").then((m) => m.default);
      posthog.init(this.apiKey, {
        api_host: this.host,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
      });
      this.initialized = true;
    } catch {
      console.warn("[Analytics] Failed to initialize PostHog");
    }
  }

  async track(event: EventType, properties?: Record<string, unknown>): Promise<void> {
    if (!isAnalyticsEnabled()) return;
    await this.init();
    try {
      const posthog = await import("posthog-js").then((m) => m.default);
      posthog.capture(event, sanitizeAnalyticsProperties(event, properties));
    } catch {
      // Silently ignore — analytics should never block the user
    }
  }

  async identify(userId: string, properties?: Record<string, unknown>): Promise<void> {
    if (!isAnalyticsEnabled()) return;
    const sanitized = sanitizeIdentify(userId, properties);
    if (!sanitized) return;
    await this.init();
    try {
      const posthog = await import("posthog-js").then((m) => m.default);
      posthog.identify(sanitized.distinctId, sanitized.properties);
    } catch {
      // Silently ignore
    }
  }

  async reset(): Promise<void> {
    if (!isAnalyticsEnabled()) return;
    try {
      const posthog = await import("posthog-js").then((m) => m.default);
      posthog.reset();
    } catch {
      // Silently ignore
    }
  }
}

function getAnalyticsAdapter(): AnalyticsAdapter {
  if (typeof window === "undefined") return new NoOpAdapter();

  const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_API_KEY?.trim();
  if (posthogKey) {
    return new PostHogAdapter(posthogKey, process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim());
  }
  if (process.env.NODE_ENV === "development") return new ConsoleAdapter();
  return new NoOpAdapter();
}

const adapter = getAnalyticsAdapter();

export function trackRegistrationCreated(properties?: {
  userId?: string;
  stellarAddress?: string;
}): void {
  adapter.track("registration_created", properties);
}

export function trackRegistrationUpdated(properties?: {
  userId?: string;
  stellarAddress?: string;
  fieldsChanged?: string[];
}): void {
  adapter.track("registration_updated", properties);
}

export function trackRecheckCompleted(properties?: {
  totalChecked?: number;
  changed?: number;
  durationMs?: number;
}): void {
  adapter.track("recheck_completed", properties);
}

export function trackBatchRecheckStarted(properties?: {
  totalRegistrations?: number;
}): void {
  adapter.track("batch_recheck_started", properties);
}

export function trackCsvExported(properties?: {
  rowCount?: number;
}): void {
  adapter.track("csv_exported", properties);
}

export function trackSorobanMirrorCompleted(properties?: {
  success?: boolean;
  txHash?: string;
  durationMs?: number;
}): void {
  adapter.track("soroban_mirror_completed", properties);
}

export function identifyUser(userId: string, properties?: Record<string, unknown>): void {
  adapter.identify(userId, properties);
}

export function resetAnalytics(): void {
  adapter.reset();
}

class ServerPostHogAdapter implements AnalyticsAdapter {
  private readonly apiKey: string;
  private readonly host: string;

  constructor(apiKey: string, host?: string) {
    this.apiKey = apiKey;
    this.host = (host ?? "https://app.posthog.com").replace(/\/$/, "");
  }

  track(event: EventType, properties?: Record<string, unknown>): void {
    if (!isAnalyticsEnabled()) return;
    const safe = sanitizeAnalyticsProperties(event, properties);
    const body = JSON.stringify({
      api_key: this.apiKey,
      event,
      distinct_id: typeof safe.userId === "string" ? safe.userId : "server",
      properties: { ...safe, $lib: "trustbridge-server" },
      timestamp: new Date().toISOString(),
    });

    fetch(`${this.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  }

  identify(userId: string, properties?: Record<string, unknown>): void {
    if (!isAnalyticsEnabled()) return;
    const sanitized = sanitizeIdentify(userId, properties);
    if (!sanitized) return;

    const payload: Record<string, unknown> = {
      api_key: this.apiKey,
      event: "$identify",
      distinct_id: sanitized.distinctId,
      $set: { ...sanitized.properties, $lib: "trustbridge-server" },
      timestamp: new Date().toISOString(),
    };

    const org = sanitized.properties.maintainerOrgId;
    if (typeof org === "string" && org) {
      payload.$groups = { organisation: org };
    }

    fetch(`${this.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  reset(): void {}
}

function getServerAnalyticsAdapter(): AnalyticsAdapter {
  const posthogKey = process.env.POSTHOG_API_KEY?.trim();
  if (posthogKey) {
    return new ServerPostHogAdapter(posthogKey, process.env.POSTHOG_HOST?.trim());
  }
  if (process.env.NODE_ENV === "development") return new ConsoleAdapter();
  return new NoOpAdapter();
}

let _serverAdapter: AnalyticsAdapter | null = null;
function serverAdapter(): AnalyticsAdapter {
  if (!_serverAdapter) _serverAdapter = getServerAnalyticsAdapter();
  return _serverAdapter;
}

export function trackServerEvent(event: EventType, properties?: Record<string, unknown>): void {
  try {
    if (!isAnalyticsEnabled()) return;
    serverAdapter().track(event, properties);
  } catch {
    // Analytics must never affect request handling.
  }
}

export function trackServerRegistrationCreated(properties?: {
  userId?: string;
  stellarAddress?: string;
}): void {
  trackServerEvent("registration_created", properties);
}

export function trackServerRegistrationUpdated(properties?: {
  userId?: string;
  stellarAddress?: string;
  fieldsChanged?: string[];
}): void {
  trackServerEvent("registration_updated", properties);
}

export function trackServerCsvExported(properties?: {
  rowCount?: number;
  triggeredBy?: string;
}): void {
  trackServerEvent("csv_exported", properties);
}

export function trackServerBatchRecheckStarted(properties?: {
  totalRegistrations?: number;
  initiatedBy?: string;
}): void {
  trackServerEvent("batch_recheck_started", properties);
}

export function trackServerDisputeOpened(properties?: {
  userId?: string;
  disputeId?: string;
  registrationId?: string;
  actorRole?: "maintainer" | "contributor";
  hasProof?: boolean;
}): void {
  trackServerEvent("dispute_opened", properties);
}

export function trackServerDisputeClosed(properties?: {
  userId?: string;
  disputeId?: string;
  status?: "VALIDATED" | "REJECTED";
}): void {
  trackServerEvent("dispute_closed", properties);
}

export function identifyServerUser(
  userId: string,
  properties?: {
    maintainerOrgId?: string;
    githubUsername?: string;
    role?: string;
  },
): void {
  if (!isAnalyticsEnabled()) return;
  serverAdapter().identify(userId, properties);
}

export { hashIdentifier, isAnalyticsEnabled } from "@/lib/analytics-policy";
