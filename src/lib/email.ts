import "server-only";

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}
import { createHash } from "node:crypto";

import { withRetry } from "@/lib/retry";
import { recordAuditLog } from "@/lib/audit";

export interface EmailNotification {
  to: string;
  subject: string;
  body: string;
  recipientName?: string;
  attachments?: EmailAttachment[];
}

export interface NotReadyNotification extends EmailNotification {
  contributorUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
  lastCheckedAt?: Date;
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
function buildIdempotencyKey(to: string, subject: string): string {
  const payload = `${to}:${subject}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export async function sendEmailNotification(
  notification: EmailNotification
): Promise<boolean> {
  const emailService = process.env.EMAIL_SERVICE || "console";

  if (emailService === "console") {
    return sendViaConsole(notification);
  }

  if (emailService === "resend") {
    return sendViaResend(notification);
  }

  console.warn(`Unknown EMAIL_SERVICE: ${emailService}, falling back to console`);
  return sendViaConsole(notification);
}

async function sendViaConsole(
  notification: EmailNotification
): Promise<boolean> {
  console.log(`[EMAIL] To: ${notification.to}`);
  console.log(`[EMAIL] Subject: ${notification.subject}`);
  console.log(`[EMAIL] Body:\n${notification.body}`);
  if (notification.attachments && notification.attachments.length > 0) {
    console.log(
      `[EMAIL] Attachments: ${notification.attachments
        .map((a) => `${a.filename} (${a.content.length} bytes)`)
        .join(", ")}`
    );
  }
  return true;
}

/**
 * Retryable HTTP error from Resend (429 = rate limit, 5xx = transient).
 * 4xx except 429 are permanent failures — don't retry.
 */
function isRetryableResendError(error: unknown): boolean {
  if (error instanceof ResendApiError) {
    if (error.status === 429) return true;
    if (error.status >= 500) return true;
    return false;
  }
  // Network errors, timeouts, etc. — retry
  return true;
}

class ResendApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ResendApiError";
  }
}

async function sendViaResend(
  notification: EmailNotification
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set, email not sent");
    return false;
  }

  const maxAttempts = getMaxAttempts();
  const idempotencyKey = buildIdempotencyKey(
    notification.to,
    notification.subject
  );

  try {
    const payload: Record<string, unknown> = {
      from: process.env.EMAIL_FROM || "noreply@trustbridge.dev",
      to: notification.to,
      subject: notification.subject,
      html: notification.body,
    };

    if (notification.attachments && notification.attachments.length > 0) {
      payload.attachments = notification.attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
      }));
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    await withRetry(
      async (attempt) => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM || "noreply@trustbridge.dev",
            to: notification.to,
            subject: notification.subject,
            html: notification.body,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new ResendApiError(
            `Resend API error: ${response.status} ${response.statusText} ${body}`.trim(),
            response.status
          );
        }

        return true;
      },
      {
        attempts: maxAttempts,
        delayMs: 500,
        backoffFactor: 2,
        shouldRetry: isRetryableResendError,
        sleep: (ms) =>
          new Promise((resolve) =>
            setTimeout(resolve, ms + Math.random() * 250)
          ),
      }
    );

    return true;
  } catch (error) {
    console.error("Failed to send email via Resend after retries:", error);

    // Surface failure in audit log (DLQ pattern)
    await recordAuditLog({
      action: "email.send_failed",
      targetLabel: notification.to,
      metadata: {
        subject: notification.subject,
        error: error instanceof Error ? error.message : String(error),
        attempts: maxAttempts,
        idempotencyKey,
      },
    }).catch(() => {});

    return false;
  }
}

export function buildNotReadyEmailBody(
  contributorUsername: string,
  reason: "unfunded" | "no_trustline" | "low_reserve"
): string {
  const reasonText = {
    unfunded: "Account not funded with XLM",
    no_trustline: "USDC trustline not established",
    low_reserve: "Insufficient spendable XLM balance",
  }[reason];

  return `
<h2>Registration Not Ready: ${contributorUsername}</h2>
<p>The registration for <strong>${contributorUsername}</strong> is currently not ready for Wave payout:</p>
<p><strong>Reason:</strong> ${reasonText}</p>
<p>Please contact the contributor to resolve this issue before the next Wave payout.</p>
<p>Visit the <a href="${process.env.NEXTAUTH_URL || "https://trustbridge.dev"}/dashboard">maintainer dashboard</a> for more details.</p>
  `.trim();
}

export interface TreasuryExportEmailDetails {
  totalContributors: number;
  readyCount: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  staleCount?: number;
  filename: string;
  exportedAt?: string;
}

export function buildTreasuryExportEmailBody(
  details: TreasuryExportEmailDetails
): string {
  const exportedAt = details.exportedAt ?? new Date().toISOString();
  const readyPercent =
    details.totalContributors > 0
      ? Math.round((details.readyCount / details.totalContributors) * 100)
      : 0;

  const staleWarning =
    details.staleCount && details.staleCount > 0
      ? `<div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:12px;border-radius:4px;margin-bottom:16px;">
<strong>⚠️ Stale Data Warning:</strong> ${details.staleCount} of ${details.totalContributors} contributor records have not been verified within the configured freshness window.
</div>`
      : "";

  return `
<h2>Nightly Treasury Contributor Export</h2>
<p>The automated nightly contributor export has completed successfully for Wave payout preparation.</p>
${staleWarning}
<table style="border-collapse:collapse;width:100%;max-width:500px;margin-bottom:16px;">
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Exported At:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${exportedAt}</td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Total Contributors:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.totalContributors}</td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Ready for Payout:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.readyCount} (${readyPercent}%)</td></tr>
  ${
    details.lowReserveCount !== undefined
      ? `<tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Low Reserve:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.lowReserveCount}</td></tr>`
      : ""
  }
  ${
    details.notReadyCount !== undefined
      ? `<tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Not Ready:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.notReadyCount}</td></tr>`
      : ""
  }
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Attached File:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;"><code>${details.filename}</code></td></tr>
</table>
<p>The full CSV dataset with current Horizon verification details is attached to this email.</p>
<p>Visit the <a href="${process.env.NEXTAUTH_URL || "https://trustbridge.dev"}/dashboard">maintainer dashboard</a> to review individual contributor records.</p>
  `.trim();
}
