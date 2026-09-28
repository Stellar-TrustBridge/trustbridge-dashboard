import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sorobanOutbox: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordAuditLog } from "@/lib/audit";
import { processSorobanOutbox } from "./soroban-outbox-worker";

describe("Soroban Outbox Worker (Issue #199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes pending outbox records and marks them completed on success", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user1", registrationId: "reg-1" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: true,
      txHash: "0xhash",
      errors: [],
    });

    const result = await processSorobanOutbox();

    expect(result.processedCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("updates attempts with exponential backoff on failure and marks FAILED when max attempts exceeded", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-2",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user2", registrationId: "reg-2" },
        status: "PENDING",
        attempts: 4,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      errors: ["RPC Timeout"],
    });

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-2" },
      data: expect.objectContaining({ status: "FAILED", attempts: 5 }),
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "soroban_outbox_exhausted",
        targetId: "outbox-2",
      })
    );
  });
});
