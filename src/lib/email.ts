import "server-only";

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}
import { createHash } from "node:crypto";

import enMessages from "../../public/locales/en.json";
import esMessages from "../../public/locales/es.json";
import ptMessages from "../../public/locales/pt.json";
import { resolveLocale, type SupportedLocale } from "@/lib/i18n-config";
import { withRetry } from "@/lib/retry";
import { recordAuditLog } from "@/lib/audit";

const EMAIL_MESSAGES: Record<SupportedLocale, typeof enMessages.email> = {
  en: enMessages.email,
  es: esMessages.email,
  pt: ptMessages.email,
};

export interface LocalizedEmailTemplate {
  subject: string;
  body: string;
}

export interface InviteEmailDetails {
  inviteCode: string;
  recipientName?: string;
  expiresAt?: Date | string | null;
  locale?: string;
}

export interface BanEmailDetails {
  githubUsername: string;
  reason: string;
  locale?: string;
}

export interface EmailNotification {
  to: string;
  subject: string;
  body: string;
  recipientName?: string;
  idempotencyScope?: string;
  attachments?: EmailAttachment[];
}

export interface NotReadyNotification extends EmailNotification {
  contributorUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
  lastCheckedAt?: Date;
}

/**
 * A single dispute that has breached its SLA window. Only non-PII fields
 * (id, age, deep link) are carried so the digest never leaks contributor
 * identity beyond the existing masking policy.
 */
export interface DisputeSlaBreachItem {
  disputeId: string;
  ageHours: number;
  slaHours: number;
  deepLink: string;
}

export interface DisputeSlaBreachDigestDetails {
  breaches: DisputeSlaBreachItem[];
  totalOpenDisputes?: number;
  generatedAt?: Date | string | null;
  locale?: string;
}

/**
 * Nudge campaign template identifiers. Each campaign maps to a localized
 * subject/body pair in the locale message bundles under `email.nudge`.
 */
export type NudgeCampaign =
  | "not_ready"
  | "invite_reminder"
  | "trustline_reminder";

export const NUDGE_CAMPAIGNS: readonly NudgeCampaign[] = [
  "not_ready",
  "invite_reminder",
  "trustline_reminder",
] as const;

export interface NudgeEmailDetails {
  campaign: NudgeCampaign;
  recipientName?: string;
  /** Optional deep link surfaced in the nudge body. */
  actionUrl?: string;
  /** Requested locale; falls back to English when missing/unsupported. */
  locale?: string;
}

/**
 * Result of resolving a nudge template. `locale` is the locale actually used
 * (after fallback) and `fallback` is true when the requested locale was
 * missing or unsupported and English was substituted.
 */
export interface ResolvedNudgeTemplate extends LocalizedEmailTemplate {
  locale: SupportedLocale;
  fallback: boolean;
}

/**
 * Stable reason codes surfaced when a nudge template cannot be resolved.
 * Callers (API routes) map these to HTTP responses without leaking internals.
 */
export type NudgeTemplateErrorCode =
  | "invalid_campaign"
  | "invalid_locale";

export class NudgeTemplateError extends Error {
  readonly code: NudgeTemplateErrorCode;

  constructor(code: NudgeTemplateErrorCode, message: string) {
    super(message);
    this.name = "NudgeTemplateError";
    this.code = code;
  }
}

export function buildInviteEmail(
  details: InviteEmailDetails
): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].invite;
  const inviteCode = details.inviteCode.trim();
  if (!inviteCode) throw new Error("Invite code is required");

  const recipientName = details.recipientName?.trim() || messages.greetingFallback;
  const expiryDate = formatEmailDate(details.expiresAt, locale);
  const registrationUrl = getRegistrationUrl();

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { recipientName })}</p>
  <p>${messages.codeLabel}: <strong><code>${escapeHtml(inviteCode)}</code></strong></p>
  <p>${expiryDate ? interpolateEmailText(messages.expires, { date: expiryDate }) : messages.noExpiry}</p>
  <p>${messages.instructions}</p>
  <p><a href="${escapeHtml(registrationUrl)}">${messages.action}</a></p>
</div>`.trim(),
  };
}

export function buildBanEmail(details: BanEmailDetails): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].ban;
  const githubUsername = details.githubUsername.trim();
  const reason = details.reason.trim();
  if (!githubUsername) throw new Error("GitHub username is required");
  if (!reason) throw new Error("Ban reason is required");

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { githubUsername })}</p>
  <p><strong>${messages.reasonLabel}:</strong> ${escapeHtml(reason)}</p>
  <p>${messages.nextSteps}</p>
</div>`.trim(),
  };
}

/**
 * Resolves a nudge campaign template for the requested locale, falling back
 * to English when the locale is missing or unsupported. Throws a
 * `NudgeTemplateError` with a stable reason code for malformed input so
 * callers can surface actionable errors instead of silent success.
 */
export function buildNudgeEmail(details: NudgeEmailDetails): ResolvedNudgeTemplate {
  if (!NUDGE_CAMPAIGNS.includes(details.campaign)) {
    throw new NudgeTemplateError(
      "invalid_campaign",
      `Unsupported nudge campaign: ${String(details.campaign)}`
    );
  }

  const requested = details.locale;
  if (requested !== undefined && typeof requested !== "string") {
    throw new NudgeTemplateError(
      "invalid_locale",
      "Nudge locale must be a string when provided"
    );
  }

  const normalized = typeof requested === "string" ? requested.trim() : "";
  const locale = resolveLocale(normalized || undefined);
  const fallback = normalized !== "" && locale !== normalized.toLowerCase();

  const messages = EMAIL_MESSAGES[locale].nudge[details.campaign];
  const recipientName =
    details.recipientName?.trim() || messages.greetingFallback;
  const actionUrl = details.actionUrl?.trim();

  return {
    locale,
    fallback,
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { recipientName })}</p>
  <p>${messages.body}</p>
  ${actionUrl ? `<p><a href="${escapeHtml(actionUrl)}">${messages.action}</a></p>` : ""}
</div>`.trim(),
  };
}

/**
 * Builds the maintainer digest section listing disputes that have breached
 * their SLA. Renders counts plus deep links only — no contributor PII.
 */
export function buildDisputeSlaBreachDigest(
  details: DisputeSlaBreachDigestDetails
): LocalizedEmailTemplate {
  const breaches = Array.isArray(details.breaches) ? details.breaches : [];
  const count = breaches.length;
  const generatedAt = formatEmailDate(details.generatedAt, "en");

  const subject =
    count > 0
      ? `[TrustBridge] ${count} dispute${count === 1 ? "" : "s"} past SLA`
      : "[TrustBridge] No disputes past SLA";

  const rows = breaches
    .map((item) => {
      const age = Number.isFinite(item.ageHours)
        ? Math.max(0, Math.round(item.ageHours))
        : 0;
      const sla = Number.isFinite(item.slaHours)
        ? Math.max(0, Math.round(item.slaHours))
        : 0;
      return `    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;"><a href="${escapeHtml(item.deepLink)}">${escapeHtml(item.disputeId)}</a></td>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;">${age}h</td>
      <td style="padding:4px 8px;border-bottom:1px solid #dee2e6;">${sla}h</td>
    </tr>`;
    })
    .join("\n");

  const summary =
    count > 0
      ? `<p><strong>${count}</strong> dispute${count === 1 ? "" : "s"} exceeded the SLA window${
          typeof details.totalOpenDisputes === "number"
            ? ` (out of ${details.totalOpenDisputes} open)`
            : ""
        }.</p>`
      : `<p>No disputes are currently past their SLA window.</p>`;

  const table =
    count > 0
      ? `  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead>
      <tr>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">Dispute</th>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">Age</th>
        <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #adb5bd;">SLA</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`
      : "";

  return {
    subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>Dispute SLA breaches</h2>
  ${summary}
${table}
  ${generatedAt ? `<p style="color:#6c757d;font-size:12px;">Generated ${escapeHtml(generatedAt)}</p>` : ""}
</div>`.trim(),
  };
}

function formatEmailDate(
  value: Date | string | null | undefined,
  locale: SupportedLocale
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function getRegistrationUrl(): string {
  try {
    const url = new URL(
      "/register",
      process.env.NEXTAUTH_URL?.trim() || "https://trustbridge.dev"
    );
    if (url.protocol === "https:" || url.hostname === "localhost") {
      return url.toString();
    }
  } catch {
    // Fall back to the canonical registration page for malformed configuration.
  }
  return "https://trustbridge.dev/register";
}

function interpolateEmailText(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    escapeHtml(values[key] ?? "")
  );
}

/**
 * Maximum number of send attempts (including the first).
 * Configurable via EMAIL_MAX_ATTEMPTS env var, capped at 5.
 */
function getMaxAttempts(): number {
  const raw = Number.parseInt(process.env.EMAIL_MAX_ATTEMPTS ?? "3", 10);
  return Math.min(Math.max(1, Number.isFinite(raw) ? raw : 3), 5);
}

/**
 * Deterministic idempotency key derived from recipient + subject.
 * Prevents duplicate emails when Resend retries a 429 and the first
 * request actually succeeded (network timeout, etc.).
 */
function buildIdempotencyKey(
  to: string,
  subject: string,
  scope?: string
): string {
  const payload = scope ? `${to}:${subject}:${scope}` : `${to}:${subject}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export async function sendEmailNotification(
  notification: EmailNotification
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY not configured; skipping send");
    return false;
  }

  const idempotencyKey = buildIdempotencyKey(
    notification.to,
    notification.subject,
    notification.idempotencyScope
  );

  try {
    await withRetry(
      async () => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || "TrustBridge <noreply@trustbridge.dev>",
            to: notification.to,
            subject: notification.subject,
            html: notification.body,
            attachments: notification.attachments,
          }),
        });

        if (!response.ok) {
          throw new Error(`Resend responded with ${response.status}`);
        }
      },
      { maxAttempts: getMaxAttempts() }
    );

    await recordAuditLog({
      action: "email.sent",
      metadata: { subject: notification.subject, scope: notification.idempotencyScope },
    });
    return true;
  } catch (error) {
    console.error("[email] Failed to send notification", error);
    return false;
  }
}

export interface DigestEmailDetails {
  /** "daily" or "weekly" — controls subject framing in the body. */
  cadence: "daily" | "weekly";
  totalContributors: number;
  readyCount: number;
  lowReserveCount: number;
  notReadyCount: number;
  /**
   * Per-contributor list. Only present when `DIGEST_INCLUDE_FULL_LIST=true`.
   * When absent the email contains counts + dashboard link only (privacy default).
   */
  notReadyList?: Array<{
    githubUsername: string;
    reason: "unfunded" | "no_trustline" | "low_reserve";
  }>;
  slaBreachCount?: number;
  slaBreachList?: Array<{
    disputeId: string;
    url: string;
    ageHours: number;
  }>;
  generatedAt?: string;
  orgTimezone?: string;
}

const DIGEST_REASON_LABELS: Record<string, string> = {
  unfunded: "Account not funded with XLM",
  no_trustline: "USDC trustline not established",
  low_reserve: "Insufficient spendable XLM balance",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const escapeDigestHtml = escapeHtml;

/**
 * Build the HTML body for the scheduled not-ready contributor digest.
 *
 * Privacy default: sends aggregate counts + a direct link to the dashboard.
 * No contributor usernames, Stellar addresses, or emails appear unless
 * `notReadyList` is explicitly provided (opt-in via DIGEST_INCLUDE_FULL_LIST).
 */
export function buildDigestEmailBody(details: DigestEmailDetails): string {
  const generatedAt = details.generatedAt ?? new Date().toISOString();
  const dashboardUrl =
    (process.env.NEXTAUTH_URL?.trim() || "https://trustbridge.dev") +
    "/dashboard";

  const cadenceLabel = details.cadence === "weekly" ? "Weekly" : "Daily";
  const notReadyTotal = details.notReadyCount + details.lowReserveCount;

  const readyPercent =
    details.totalContributors > 0
      ? Math.round((details.readyCount / details.totalContributors) * 100)
      : 0;

  const alertBanner =
    notReadyTotal > 0
      ? `<div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
  <strong>⚠️ Action required:</strong> ${notReadyTotal} contributor${notReadyTotal === 1 ? "" : "s"} cannot receive a Wave payout yet.
  Visit the <a href="${dashboardUrl}" style="color:#856404;">maintainer dashboard</a> to review and resolve.
</div>`
      : `<div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
  <strong>✅ All contributors are ready</strong> for Wave payout as of this digest.
</div>`;

  const statsTable = `
<table style="border-collapse:collapse;width:100%;max-width:500px;margin-bottom:20px;">
  <thead>
    <tr style="background:#f8f9fa;">
      <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:left;">Status</th>
      <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">Count</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">Total contributors</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.totalContributors}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;border:1px solid #dee2e6;">✅ Ready for payout</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.readyCount} (${readyPercent}%)</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">⚠️ Low reserve</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.lowReserveCount}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;border:1px solid #dee2e6;">❌ Not ready</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.notReadyCount}</td>
    </tr>
  </tbody>
</table>`.trim();

  let fullListSection = "";
  if (details.notReadyList && details.notReadyList.length > 0) {
    const rows = details.notReadyList
      .map(
        (entry, i) =>
          `<tr${i % 2 === 0 ? "" : ' style="background:#f8f9fa;"'}>
        <td style="padding:6px 12px;border:1px solid #dee2e6;font-family:monospace;">@${escapeDigestHtml(entry.githubUsername)}</td>
        <td style="padding:6px 12px;border:1px solid #dee2e6;">${escapeDigestHtml(DIGEST_REASON_LABELS[entry.reason] ?? entry.reason)}</td>
      </tr>`
      )
      .join("\n");

    fullListSection = `
<h3 style="font-size:14px;margin-top:24px;margin-bottom:8px;">Not-ready contributors (${details.notReadyList.length})</h3>
<table style="border-collapse:collapse;width:100%;max-width:600px;font-size:13px;">
  <thead>
    <tr style="background:#f8f9fa;">
      <th style="padding:6px 12px;border:1px solid #dee2e6;text-align:left;">Contributor</th>
      <th style="padding:6px 12px;border:1px solid #dee2e6;text-align:left;">Reason</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<p style="font-size:12px;color:#6c757d;margin-top:8px;">
  This list is included because <code>DIGEST_INCLUDE_FULL_LIST=true</code> is set.
  Remove that setting to send counts-only digests.
</p>`.trim();
  }

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#212529;">
  <h2 style="margin-bottom:4px;">${cadenceLabel} Contributor Readiness Digest</h2>
  <p style="color:#6c757d;font-size:13px;margin-top:0;margin-bottom:20px;">
    Generated ${escapeDigestHtml(generatedAt)} · TrustBridge Dashboard
  </p>
  ${alertBanner}
  ${statsTable}
  ${fullListSection}
  <p style="margin-top:24px;">
    <a href="${dashboardUrl}" style="display:inline-block;background:#3E1BDB;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;font-weight:600;">
      Open maintainer dashboard →
    </a>
  </p>
  <hr style="border:none;border-top:1px solid #dee2e6;margin:24px 0;" />
  <p style="font-size:12px;color:#6c757d;">
    You are receiving this digest because your address is configured as DIGEST_EMAIL (or TREASURY_EXPORT_EMAIL).
    To unsubscribe, remove your address from the environment variable.
  </p>
</div>`.trim();
}
