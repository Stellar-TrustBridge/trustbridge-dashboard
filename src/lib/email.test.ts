import { describe, it, expect, vi } from "vitest";
import {
  sendEmailNotification,
  buildNotReadyEmailBody,
  buildTreasuryExportEmailBody,
} from "@/lib/email";

describe("Email service", () => {
  it("builds not-ready email body with unfunded reason", () => {
    const body = buildNotReadyEmailBody("contributor1", "unfunded");
    expect(body).toContain("contributor1");
    expect(body).toContain("Account not funded with XLM");
    expect(body).toContain("maintainer dashboard");
  });

  it("builds not-ready email body with no_trustline reason", () => {
    const body = buildNotReadyEmailBody("contributor2", "no_trustline");
    expect(body).toContain("contributor2");
    expect(body).toContain("USDC trustline not established");
  });

  it("builds not-ready email body with low_reserve reason", () => {
    const body = buildNotReadyEmailBody("contributor3", "low_reserve");
    expect(body).toContain("contributor3");
    expect(body).toContain("Insufficient spendable XLM balance");
  });

  it("builds treasury export email body with summary and stale warning", () => {
    const body = buildTreasuryExportEmailBody({
      totalContributors: 50,
      readyCount: 45,
      lowReserveCount: 3,
      notReadyCount: 2,
      staleCount: 5,
      filename: "contributors-2026-08-30.csv",
      exportedAt: "2026-08-30T05:00:00.000Z",
    });

    expect(body).toContain("Nightly Treasury Contributor Export");
    expect(body).toContain("Total Contributors:");
    expect(body).toContain("50");
    expect(body).toContain("Ready for Payout:");
    expect(body).toContain("45 (90%)");
    expect(body).toContain("Low Reserve:");
    expect(body).toContain("3");
    expect(body).toContain("Not Ready:");
    expect(body).toContain("2");
    expect(body).toContain("contributors-2026-08-30.csv");
    expect(body).toContain("Stale Data Warning:");
    expect(body).toContain("5 of 50 contributor records");
  });

  it("builds treasury export email body without stale warning when staleCount is 0", () => {
    const body = buildTreasuryExportEmailBody({
      totalContributors: 10,
      readyCount: 10,
      staleCount: 0,
      filename: "contributors-2026-08-30.csv",
    });

    expect(body).toContain("Nightly Treasury Contributor Export");
    expect(body).not.toContain("Stale Data Warning");
  });

  it("sends notification with console service and attachments", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const result = await sendEmailNotification({
      to: "treasury@example.com",
      subject: "Test export email",
      body: "Test body",
      attachments: [
        {
          filename: "test.csv",
          content: "id,username\n1,alice",
          contentType: "text/csv",
        },
      ],
    });

    expect(result).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("treasury@example.com"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("test.csv"));
    consoleSpy.mockRestore();
  });
});
