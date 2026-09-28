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
      update: vi.fn(),
    },
  },
}));

vi.mock("stellar-sdk", () => ({
  Contract: vi.fn().mockImplementation(() => ({
    call: mockContractCall,
  })),
  rpc: {
    Server: vi.fn(),
  },
  scValToNative: mockScValToNative,
}));

import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  getContractSyncHealth,
  resetContractSyncState,
  syncContractToPostgres,
} from "@/lib/contract-sync";

// Helper: build a minimal Registration row shape returned by prisma.findMany
function makeExistingReg(
  stellarAddress: string,
  githubUsername: string | null = null
) {
  return {
    id: `id-${stellarAddress}`,
    stellarAddress,
    user: { githubUsername },
  };
}

describe("contract-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContractSyncState();
    delete process.env.CONTRACT_SYNC_MIN_INTERVAL_MS;
    delete process.env.SOROBAN_CONTRACT_ID;
    mockContractCall.mockResolvedValue([]);
    mockScValToNative.mockReturnValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // The update query should have been called
      expect(prisma.registration.update).toHaveBeenCalledTimes(1);
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
          where: { id: "id-GEXISTS1ADDRESS" },
          data: { githubUsername: "alice-new" },
        })
      );
    });

    it("skips the update and does not throw when the new username is already taken", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      // Another user already owns the target username
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "other-user",
      } as never);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
    });

    it("does not issue an empty registration.update for the mismatch path", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      await syncContractToPostgres();

      // No empty-data registration updates should ever be issued
      for (const call of vi.mocked(prisma.registration.update).mock.calls) {
        expect(call[0]?.data).not.toEqual({});
      }
    });
  });

  describe("mixed create / update / unchanged in one sync run", () => {
    it("correctly partitions all three paths", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Three contract entries:
      //   GNEW — not in Postgres → created
      //   GCHANGED — in Postgres with different username → updated
      //   GSAME — in Postgres with same username → unchanged
      mockScValToNative.mockReturnValue([
        ["GNEW", "newbie"],
        ["GCHANGED", "changed-new"],
        ["GSAME", "stable"],
      ]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GCHANGED", "changed-old") as never,
        makeExistingReg("GSAME", "stable") as never,
      ]);

      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(3);
      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.unchanged).toBe(1);

      // Audit log should carry the correct breakdown
      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "contract.sync",
          metadata: expect.objectContaining({
            created: 1,
            updated: 1,
            unchanged: 1,
          }),
        })
      );
    });
  });
});
