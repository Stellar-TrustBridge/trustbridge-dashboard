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
 * Reason codes emitted when an address is skipped because it is on the
 * bounce suppression list. Surfaced in metrics and audit logs so operators
 * can distinguish suppression from transient send failures.
 */
export type EmailSuppressionReason =
  | "suppressed_bounce"
  | "suppressed_complaint";

export interface EmailSuppressionResult {
  suppressed: true;
  reason: EmailSuppressionReason;
  to: string;
}

/**
 * Normalizes an email address for suppression-list comparison. Returns
 * `null` for empty/malformed input so callers can fail with a stable
 * reason code instead of silently sending.
 */
export function normalizeEmailAddress(
  address: string | null | undefined
): string | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return null;
  // Conservative RFC-5322-ish check: single @, non-empty local/domain, dot in domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parses the bounce suppression list from `EMAIL_BOUNCE_SUPPRESSION_LIST`
 * (comma-separated addresses). Malformed entries are ignored so a single
 * bad value cannot disable suppression for the whole list.
 */
export function parseBounceSuppressionList(
  raw: string | null | undefined = process.env.EMAIL_BOUNCE_SUPPRESSION_LIST
): Set<string> {
  const set = new Set<string>();
  if (typeof raw !== "string") return set;
  for (const entry of raw.split(",")) {
    const normalized = normalizeEmailAddress(entry);
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * Returns a suppression result when `to` is on the bounce suppression list,
 * otherwise `null`. Used by nudges/digests to skip bounced addresses.
 */
export function checkBounceSuppression(
  to: string | null | undefined,
  list: Set<string> = parseBounceSuppressionList()
): EmailSuppressionResult | null {
  const normalized = normalizeEmailAddress(to);
  if (!normalized) return null;
  if (list.has(normalized)) {
    return { suppressed: true, reason: "suppressed_bounce", to: normalized };
  }
  return null;
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
  const suppression = checkBounceSuppression(notification.to);
  if (suppression) {
    await recordAuditLog({
      action: "email.suppressed",
      metadata: {
        reason: suppression.reason,
        to: suppression.to,
        subject: notification.subject,
      },
    });
    return false;
  }

  const maxAttempts = getMaxAttempts();
  const idempotencyKey = buildIdempotencyKey(
    notification.to,
    notification.subject,
    notification.idempotencyScope
  );

  return withRetry(
    async () => {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ""}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM ?? "TrustBridge <noreply@trustbridge.dev>",
          to: notification.to,
          subject: notification.subject,
          html: notification.body,
          attachments: notification.attachments,
        }),
      });
      if (!response.ok) {
        throw new Error(`Resend responded with ${response.status}`);
      }
      return true;
    },
    { attempts: maxAttempts }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
