import { prisma } from './prisma';
import { logger } from './logger';

export interface TokenAuditEvent {
  tokenId: string;
  action: string;
  actor?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persist a token audit event on a best-effort basis.
 *
 * Audit writes must never fail the primary auth path: any error from the
 * underlying client is logged and swallowed so callers can continue.
 */
export async function recordTokenAudit(event: TokenAuditEvent): Promise<void> {
  try {
    await prisma.tokenAudit.create({
      data: {
        tokenId: event.tokenId,
        action: event.action,
        actor: event.actor ?? null,
        metadata: event.metadata ?? null,
      },
    });
  } catch (error) {
    logger.error('Failed to record token audit event', {
      tokenId: event.tokenId,
      action: event.action,
      error,
    });
  }
}
