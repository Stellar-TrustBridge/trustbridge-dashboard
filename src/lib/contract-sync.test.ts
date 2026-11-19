import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockContractCall = vi.hoisted(() => vi.fn());
const mockScValToNative = vi.hoisted(() => vi.fn(() => []));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("stellar-sdk", () => ({
  Contract: vi.fn().mockImplementation(() => ({
    call: mockContractCall,
  })),
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: "mock-retval" },
      }),
    })),
    Api: {
      isSimulationError: vi.fn().mockReturnValue(false),
    },
  },
  Account: vi.fn().mockImplementation(() => ({})),
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnValue({
      setTimeout: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue({}),
      }),
    }),
  })),
  nativeToScVal: vi.fn((value: unknown) => value),
  scValToNative: mockScValToNative,
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  xdr: { ScVal: vi.fn() },
}));

import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  evaluateContractSyncLag,
  getContractSyncAlertMetrics,
  getContractSyncLagState,
  getContractSyncLagThresholdMs,
  getContractSyncHealth,
  resetContractSyncState,
  syncContractToPostgres,
} from "@/lib/contract-sync";

// Helper: build a minimal Registration row shape returned by prisma.findMany
function makeExistingReg(
  stellarAddress: string,
  githubUsername: string | null = null,
  userId?: string
) {
  const resolvedUserId = userId ?? `user-${stellarAddress}`;
  return {
    id: `id-${stellarAddress}`,
    stellarAddress,
    userId: resolvedUserId,
    user: { githubUsername },
  };
}

describe("contract-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContractSyncState();
    delete process.env.CONTRACT_SYNC_MIN_INTERVAL_MS;
    delete process.env.SOROBAN_CONTRACT_ID;
    delete process.env.CONTRACT_SYNC_LAG_THRESHOLD_MS;
    delete process.env.CONTRACT_SYNC_STALL_THRESHOLD_MS;
    delete process.env.CONTRACT_SYNC_ALERT_WEBHOOK_URL;
    delete process.env.CONTRACT_SYNC_ALERT_COOLDOWN_MS;
    delete process.env.CONTRACT_SYNC_ALERT_PAGERDUTY_KEY;
    mockContractCall.mockResolvedValue([]);
    mockScValToNative.mockReturnValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ------------------------------------------------------------------
  // Existing baseline tests
  // ------------------------------------------------------------------

  it("runs a sync, records an audit log, and updates health on success", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CABC123";

    const result = await syncContractToPostgres();

    expect(result.status).toBe("ok");
    expect(result.synced).toBe(0);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contract.sync" })
    );
    expect(getContractSyncHealth()).toEqual(result);
  });

  it("never throws when Postgres sync fails, and records the error", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CABC123";
    vi.mocked(prisma.registration.findMany).mockRejectedValue(
      new Error("Horizon RPC outage")
    );

    const result = await syncContractToPostgres();

    expect(result.status).toBe("error");
    expect(result.errors).toContain("Horizon RPC outage");
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contract.sync",
        metadata: { error: "Horizon RPC outage" },
      })
    );
    expect(getContractSyncHealth()?.status).toBe("error");
  });

  it("rate-limits back-to-back triggers instead of re-hitting Soroban", async () => {
    process.env.CONTRACT_SYNC_MIN_INTERVAL_MS = "60000";
    process.env.SOROBAN_CONTRACT_ID = "CABC123";

    const first = await syncContractToPostgres();
    const second = await syncContractToPostgres();

    expect(first.status).toBe("ok");
    expect(second.status).toBe("skipped");
    expect(mockContractCall).toHaveBeenCalledTimes(1);
    expect(prisma.registration.findMany).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // Counter behavior: created vs updated vs unchanged
  // ------------------------------------------------------------------

  describe("created counter", () => {
    it("increments created for each contract address absent from Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract returns two addresses that are NOT in Postgres
      mockScValToNative.mockReturnValue([
        ["GNEW1ADDRESS", "alice"],
        ["GNEW2ADDRESS", "bob"],
      ]);

      // Postgres has no registrations
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.synced).toBe(2);
    });

    it("does not increment created for addresses already in Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract returns one address that IS in Postgres (same username)
      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.created).toBe(0);
      expect(result.unchanged).toBe(1);
    });

    it("counts zero created when all contract addresses exist in Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GADDR1", "alice"],
        ["GADDR2", "bob"],
        ["GADDR3", "carol"],
      ]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GADDR1", "alice") as never,
        makeExistingReg("GADDR2", "bob") as never,
        makeExistingReg("GADDR3", "carol") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(3);
    });
  });

  describe("updated counter", () => {
    it("increments updated when the contract reports a changed GitHub username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract reports a different githubUsername for an existing address
      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.unchanged).toBe(0);
      // The linked User row (not the Registration row) carries the username.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-GEXISTS1ADDRESS" },
          data: expect.objectContaining({ githubUsername: "alice-new" }),
        })
      );
    });

    it("does not increment updated when the username is unchanged", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Username-mismatch path: linked User.githubUsername is updated safely
  // ------------------------------------------------------------------

  describe("username mismatch", () => {
    it("updates the linked User.githubUsername when it diverges from the contract", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      // No other user already owns the new username
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(1);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-GEXISTS1ADDRESS" },
          data: expect.objectContaining({ githubUsername: "alice-new" }),
        })
      );
    });

    it("does not clobber a User that already owns the new username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      // Another user already owns the new username
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        id: "other-user",
        githubUsername: "alice-new",
      } as never);

      const result = await syncContractToPostgres();

      // Conflict: counted as unchanged, and the other owner's row is untouched.
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Registration parsing edge cases
  // ------------------------------------------------------------------

  describe("registration parsing edge cases", () => {
    it("ignores a null contract payload without throwing", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue(null);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
    });

    it("ignores an undefined contract payload without throwing", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue(undefined);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("ignores an empty contract payload", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue([]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("skips malformed entries that are not address/username pairs", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        null,
        undefined,
        "GONLYADDRESS",
        [],
        ["GADDR1"],
        ["GADDR2", "alice", "extra"],
        ["GADDR3", "bob"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      // Only the well-formed pair should be counted
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("skips entries with a missing or non-string address", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        [null, "alice"],
        [undefined, "bob"],
        [123, "carol"],
        ["", "dave"],
        ["GADDR1", "erin"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("skips entries with a missing or non-string username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GADDR1", null],
        ["GADDR2", undefined],
        ["GADDR3", 42],
        ["GADDR4", ""],
        ["GADDR5", "frank"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("treats a null username on an existing registration as unchanged", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", null) as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
    });

    it("handles duplicate addresses in the contract payload deterministically", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GDUPADDRESS", "alice"],
        ["GDUPADDRESS", "alice"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("does not throw when the contract payload is a non-iterable object", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue({ unexpected: true });

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("records an error when the contract call itself rejects", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      // The read path builds a simulation transaction synchronously, so a
      // failing contract call surfaces as a synchronous throw (not a
      // rejected promise) inside `simulateContractRead`.
      mockContractCall.mockImplementation(() => {
        throw new Error("RPC unavailable");
      });

      const result = await syncContractToPostgres();

      expect(result.status).toBe("error");
      expect(result.errors).toContain("RPC unavailable");
    });
  });

  // ------------------------------------------------------------------
  // Lag monitoring (issue #659): injected clocks + cursors only — these
  // tests never touch a real RPC endpoint or wall-clock timers.
  // ------------------------------------------------------------------

  describe("lag monitoring", () => {
    const LAG_MS = 15 * 60 * 1000;
    const STALL_MS = 60 * 60 * 1000;
    let now: number;
    const clock = () => now;

    beforeEach(() => {
      now = Date.parse("2026-01-01T00:00:00.000Z");
      process.env.CONTRACT_SYNC_MIN_INTERVAL_MS = "0";
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      // Reset again so `processStartedAt` lines up with the injected epoch.
      resetContractSyncState();
    });

    async function runOk(cursor: string | null = null) {
      return syncContractToPostgres({ now: clock, cursor });
    }

    it("reports ok progress right after a successful run", async () => {
      const result = await runOk("ledger-100");

      expect(result.status).toBe("ok");
      const lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("ok");
      expect(lag.reason).toBe("ok");
      expect(lag.sinceLastSuccessMs).toBe(0);
      expect(lag.cursor).toBe("ledger-100");
      expect(lag.sinceLastCursorAdvanceMs).toBe(0);
      expect(lag.thresholdMs).toBe(LAG_MS);
      expect(lag.stallThresholdMs).toBe(STALL_MS);
    });

    it("flags sync_delayed once the lag threshold passes and sync_stalled past the stall threshold", async () => {
      await runOk("ledger-100");

      now += LAG_MS;
      let lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("lagging");
      expect(lag.reason).toBe("sync_delayed");
      expect(lag.sinceLastSuccessMs).toBe(LAG_MS);

      now += STALL_MS - LAG_MS; // total = stall threshold since last success
      lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("stalled");
      expect(lag.reason).toBe("sync_stalled");
    });

    it("flags a frozen RPC cursor as cursor_stalled even while runs keep succeeding", async () => {
      await runOk("ledger-100");
      now += 60 * 1000;
      await runOk("ledger-100"); // cursor unchanged — run still succeeds

      now += STALL_MS;
      await runOk("ledger-100"); // runs are fresh, but the cursor has not moved
      const lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("stalled");
      expect(lag.reason).toBe("cursor_stalled");
      expect(lag.cursor).toBe("ledger-100");
      expect(lag.sinceLastSuccessMs).toBe(0);
      expect(lag.sinceLastCursorAdvanceMs).toBe(60 * 1000 + STALL_MS);
    });

    it("recovers to ok when the cursor advances after a stall", async () => {
      await runOk("ledger-100");
      now += 60 * 1000;
      await runOk("ledger-100");
      now += STALL_MS;
      await runOk("ledger-100");
      expect(getContractSyncLagState({ now }).reason).toBe("cursor_stalled");

      // RPC starts moving again: a new cursor value resets the stall clock.
      now += 60 * 1000;
      await runOk("ledger-200");
      const lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("ok");
      expect(lag.reason).toBe("ok");
      expect(lag.sinceLastCursorAdvanceMs).toBe(0);
      expect(lag.cursor).toBe("ledger-200");
    });

    it("recovers to ok when a successful run lands after a sync stall", async () => {
      await runOk("ledger-100");
      now += STALL_MS + LAG_MS;
      expect(getContractSyncLagState({ now }).reason).toBe("sync_stalled");

      await runOk("ledger-101");
      const lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("ok");
      expect(lag.reason).toBe("ok");
      expect(lag.sinceLastSuccessMs).toBe(0);
    });

    it("reports never_succeeded once the process is older than the stall threshold with no success", () => {
      const lag = getContractSyncLagState({ now: Date.now() + STALL_MS + 60_000 });
      expect(lag.status).toBe("stalled");
      expect(lag.reason).toBe("never_succeeded");
      expect(lag.lastSuccessAt).toBeNull();
    });

    it("treats an unconfigured contract as intentionally idle, not stalled", async () => {
      delete process.env.SOROBAN_CONTRACT_ID;

      const result = await syncContractToPostgres({ now: clock });
      expect(result.failureMode).toBe("contract_not_configured");

      const lag = getContractSyncLagState({ now: now + STALL_MS * 2 });
      expect(lag.status).toBe("ok");
      expect(lag.reason).toBe("not_configured");
    });

    it("falls back to documented defaults when the threshold configuration is invalid", () => {
      process.env.CONTRACT_SYNC_LAG_THRESHOLD_MS = "not-a-number";
      process.env.CONTRACT_SYNC_STALL_THRESHOLD_MS = "-5";
      expect(getContractSyncLagThresholdMs()).toBe(LAG_MS);
      expect(getContractSyncLagState({ now }).stallThresholdMs).toBe(STALL_MS);
    });

    it("does not record progress when the Postgres merge fails", async () => {
      await runOk("ledger-100");
      now += 60 * 1000;
      vi.mocked(prisma.registration.findMany).mockRejectedValue(new Error("db down"));

      const result = await syncContractToPostgres({ now: clock, cursor: "ledger-101" });
      expect(result.status).toBe("error");

      // The failed run must not refresh progress: the lag clock keeps ticking
      // from the last fully successful run.
      now += STALL_MS;
      const lag = getContractSyncLagState({ now });
      expect(lag.status).toBe("stalled");
      expect(lag.reason).toBe("sync_stalled");
      expect(lag.sinceLastSuccessMs).toBe(60_000 + STALL_MS);
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    });

    describe("maintainer alerts", () => {
      const WEBHOOK = "https://hooks.example.test/contract-sync";
      let fetchMock: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        process.env.CONTRACT_SYNC_ALERT_WEBHOOK_URL = WEBHOOK;
        process.env.CONTRACT_SYNC_ALERT_COOLDOWN_MS = "1000";
        fetchMock = vi.fn(async () => ({ ok: true }) as Response);
        vi.stubGlobal("fetch", fetchMock);
      });

      it("notifies once per stall episode and stays silent while the stall persists", async () => {
        // Runs keep succeeding but the RPC cursor never advances: after the
        // stall threshold the state flips to cursor_stalled and alerts once.
        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        expect(getContractSyncLagState({ now }).status).toBe("ok");

        now += STALL_MS;
        await runOk("ledger-100");
        expect(getContractSyncLagState({ now }).reason).toBe("cursor_stalled");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getContractSyncAlertMetrics().sentCount).toBe(1);

        // Sustained stall: further runs in the same episode stay silent.
        now += 60_000;
        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getContractSyncAlertMetrics().sentCount).toBe(1);
      });

      it("alerts when repeated failing runs leave the sync stalled", async () => {
        await runOk("ledger-100");

        // RPC starts failing: no further progress is recorded.
        mockContractCall.mockImplementation(() => {
          throw new Error("RPC unavailable");
        });
        now += STALL_MS + 1000;
        const result = await syncContractToPostgres({ now: clock });
        expect(result.status).toBe("error");

        expect(getContractSyncLagState({ now }).reason).toBe("sync_stalled");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const payload = fetchMock.mock.calls[0][1]?.body
          ? JSON.parse(fetchMock.mock.calls[0][1].body as string)
          : null;
        expect(payload).toMatchObject({
          source: "trustbridge-contract-sync",
          status: "stalled",
          reason: "sync_stalled",
        });
        expect(payload.text).toContain("🚨");
      });

      it("closes the episode on recovery so a later stall notifies again", async () => {
        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        now += STALL_MS;
        await runOk("ledger-100"); // cursor_stalled → first alert
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Recovery: the cursor advances, closing the episode.
        now += 1000;
        await runOk("ledger-200");
        expect(getContractSyncLagState({ now }).status).toBe("ok");

        // New stall, past the alert cooldown: a second notification is sent.
        now += STALL_MS + 2000;
        await runOk("ledger-200");
        expect(getContractSyncLagState({ now }).reason).toBe("cursor_stalled");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(getContractSyncAlertMetrics().sentCount).toBe(2);
      });

      it("never throws and throttles retries when webhook delivery fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        fetchMock.mockRejectedValue(new Error("webhook unreachable"));

        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        now += STALL_MS;

        await expect(syncContractToPostgres({ now: clock, cursor: "ledger-100" })).resolves.toMatchObject({
          status: "ok",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getContractSyncAlertMetrics().sentCount).toBe(0);

        // Inside the cooldown: no second delivery attempt.
        now += 500;
        await syncContractToPostgres({ now: clock, cursor: "ledger-100" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Past the cooldown: the failed episode is retried.
        now += 1000;
        await syncContractToPostgres({ now: clock, cursor: "ledger-100" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("treats a non-OK webhook response as a failed delivery", async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        now += STALL_MS;
        await runOk("ledger-100");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getContractSyncAlertMetrics().sentCount).toBe(0);
        expect(getContractSyncAlertMetrics().lastSentAt).toBeNull();
      });

      it("does not alert when no webhook is configured", async () => {
        delete process.env.CONTRACT_SYNC_ALERT_WEBHOOK_URL;

        await runOk("ledger-100");
        now += 60_000;
        await runOk("ledger-100");
        now += STALL_MS;
        await runOk("ledger-100");

        expect(getContractSyncLagState({ now }).status).toBe("stalled");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getContractSyncAlertMetrics().sentCount).toBe(0);
      });
    });

    describe("pure evaluation boundaries", () => {
      const snapshotBase = {
        processStartedAt: 1_000,
        lastSuccessAt: null as number | null,
        cursor: null as { value: string; advancedAt: number } | null,
      };

      it("is ok below the lag threshold, lagging exactly at it", () => {
        const thresholds = { thresholdMs: LAG_MS, stallThresholdMs: STALL_MS };
        const lastSuccessAt = 10_000;

        expect(
          evaluateContractSyncLag({ ...snapshotBase, now: 10_000 + LAG_MS - 1, lastSuccessAt }, thresholds).status
        ).toBe("ok");
        expect(
          evaluateContractSyncLag({ ...snapshotBase, now: 10_000 + LAG_MS, lastSuccessAt }, thresholds).status
        ).toBe("lagging");
        expect(
          evaluateContractSyncLag({ ...snapshotBase, now: 10_000 + STALL_MS, lastSuccessAt }, thresholds)
        ).toMatchObject({ status: "stalled", reason: "sync_stalled" });
      });

      it("stays ok while the cursor advances within the stall window", () => {
        const thresholds = { thresholdMs: LAG_MS, stallThresholdMs: STALL_MS };
        const cursor = { value: "ledger-1", advancedAt: 20_000 };
        const now = 20_000 + STALL_MS - 1;
        const lastSuccessAt = now - 1; // recent success, frozen cursor

        const lag = evaluateContractSyncLag(
          { ...snapshotBase, now, lastSuccessAt, cursor },
          thresholds
        );
        expect(lag).toMatchObject({ status: "ok", reason: "ok" });
        expect(lag.sinceLastCursorAdvanceMs).toBe(STALL_MS - 1);
      });
    });
  });
});
