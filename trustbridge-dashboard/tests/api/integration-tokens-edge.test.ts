import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Prisma client used by token-audit.ts so tests never touch a live DB.
const mockCreate = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tokenAudit: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

import { recordTokenAudit } from '@/lib/token-audit';

describe('recordTokenAudit best-effort writes', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the expected audit fields on a successful write', async () => {
    mockCreate.mockResolvedValue({ id: 'audit-1' });

    await recordTokenAudit({
      tokenId: 'token-123',
      action: 'created',
      actorId: 'user-456',
      metadata: { scope: 'read' },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      tokenId: 'token-123',
      action: 'created',
      actorId: 'user-456',
      metadata: { scope: 'read' },
    });
    expect(arg.data.timestamp ?? arg.data.createdAt).toBeDefined();
  });

  it('logs the error and does not throw when the write fails', async () => {
    const writeError = new Error('db unavailable');
    mockCreate.mockRejectedValue(writeError);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordTokenAudit({
        tokenId: 'token-123',
        action: 'revoked',
        actorId: 'user-456',
      }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
