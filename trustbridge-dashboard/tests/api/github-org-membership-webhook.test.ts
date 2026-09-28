import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock the replay processing service so tests stay isolated from real GitHub delivery.
const processReplayMock = vi.fn();
vi.mock('@/lib/github-org-membership-replay', () => ({
  processOrgMembershipReplay: (...args: unknown[]) => processReplayMock(...args),
}));

// Mock auth so we can control admin vs. unauthenticated requests.
const getSessionMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
}));

import { POST } from '@/app/api/webhooks/github-org-membership/replay/route';

const VALID_CSRF = 'valid-csrf-token';

function buildRequest(options: {
  body?: unknown;
  csrf?: string | null;
  rawBody?: string;
} = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.csrf !== null) {
    headers.set('x-csrf-token', options.csrf ?? VALID_CSRF);
  }
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : JSON.stringify(options.body ?? { deliveryId: 'delivery-123' });
  return new NextRequest('http://localhost/api/webhooks/github-org-membership/replay', {
    method: 'POST',
    headers,
    body,
  });
}

describe('GitHub org-membership replay route', () => {
  beforeEach(() => {
    processReplayMock.mockReset();
    processReplayMock.mockResolvedValue({ replayed: true });
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ user: { id: 'admin-1', role: 'admin' } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replays successfully for a valid admin request with a valid CSRF token', async () => {
    const res = await POST(buildRequest({ body: { deliveryId: 'delivery-123' } }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true });
    expect(processReplayMock).toHaveBeenCalledTimes(1);
    expect(processReplayMock).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'delivery-123' }),
    );
  });

  it('rejects a request missing the CSRF token and does not trigger processing', async () => {
    const res = await POST(buildRequest({ csrf: null }));

    expect(res.status).toBe(403);
    expect(processReplayMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request and does not trigger processing', async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await POST(buildRequest());

    expect([401, 403]).toContain(res.status);
    expect(processReplayMock).not.toHaveBeenCalled();
  });

  it('rejects a non-admin request and does not trigger processing', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user-1', role: 'member' } });

    const res = await POST(buildRequest());

    expect([401, 403]).toContain(res.status);
    expect(processReplayMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed request body and does not trigger processing', async () => {
    const res = await POST(buildRequest({ rawBody: '{ not valid json' }));

    expect(res.status).toBe(400);
    expect(processReplayMock).not.toHaveBeenCalled();
  });
});
