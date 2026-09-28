import { test, expect } from "@playwright/test";
import {
  signInAsContributor,
  mockMaintainerSession,
  signInWithSessionCookie,
  interceptApi,
} from "./helpers";

/**
 * Visual regression tests across key views (landing, register, dashboard)
 * in both light and dark color schemes.
 *
 * Flakiness guardrails:
 * - Timestamps, dynamic latency counters, and dates are masked.
 * - API responses are mocked to ensure deterministic UI state.
 * - Font rendering is allowed to settle with full-page screenshots.
 */

test.describe("Visual Regression (Dark & Light)", () => {
  const dynamicMaskSelectors = [
    '[data-testid="last-checked"]',
    '[data-testid="relative-time"]',
    "time",
    ".text-muted-foreground time",
    '[data-testid="horizon-latency"]',
    '[data-testid="audit-timestamp"]',
  ];

  test.describe("Landing Page", () => {
    test("landing page - light mode", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Verify essential element is rendered before snapping screenshot
      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("landing-light.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });

    test("landing page - dark mode", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("landing-dark.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });
  });

  test.describe("Register Page (Mock)", () => {
    test("register page - light mode", async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: "light" });

      await signInAsContributor(context, page, {
        id: "contributor-mock",
        githubUsername: "mockuser",
        name: "Mock User",
      });

      await interceptApi(page, "**/api/register", {
        stellarAddress: "GBX7ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
        funded: true,
        trustlineReady: true,
        trustlineAuthorized: true,
        xlmBalance: "10.0000000",
        spendableXlmBalance: "8.5000000",
        readiness: "ready",
        verified: true,
        lastCheckedAt: "2026-09-24T00:00:00.000Z",
      });

      await page.goto("/register");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("register-light.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });

    test("register page - dark mode", async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: "dark" });

      await signInAsContributor(context, page, {
        id: "contributor-mock",
        githubUsername: "mockuser",
        name: "Mock User",
      });

      await interceptApi(page, "**/api/register", {
        stellarAddress: "GBX7ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
        funded: true,
        trustlineReady: true,
        trustlineAuthorized: true,
        xlmBalance: "10.0000000",
        spendableXlmBalance: "8.5000000",
        readiness: "ready",
        verified: true,
        lastCheckedAt: "2026-09-24T00:00:00.000Z",
      });

      await page.goto("/register");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("register-dark.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });
  });

  test.describe("Dashboard Page (Mock)", () => {
    const mockContributors = [
      {
        id: "mock-1",
        githubUsername: "alice",
        stellarAddress: "GBX7ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
        funded: true,
        trustlineReady: true,
        trustlineAuthorized: true,
        xlmBalance: "25.0000000",
        spendableXlmBalance: "23.0000000",
        readiness: "ready",
        verified: true,
        lastCheckedAt: "2026-09-24T00:00:00.000Z",
      },
      {
        id: "mock-2",
        githubUsername: "bob",
        stellarAddress: "GAY2BCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
        funded: false,
        trustlineReady: false,
        trustlineAuthorized: false,
        xlmBalance: "0.0000000",
        spendableXlmBalance: "0.0000000",
        readiness: "not_ready",
        verified: false,
        lastCheckedAt: "2026-09-24T00:00:00.000Z",
      },
    ];

    test("dashboard page - light mode", async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: "light" });

      const maintainer = {
        id: "maintainer-mock",
        githubUsername: "lead-maintainer",
        name: "Lead Maintainer",
        isMaintainer: true,
      };

      await signInWithSessionCookie(context, maintainer);
      await mockMaintainerSession(page, maintainer);

      await interceptApi(page, "**/api/contributors*", {
        contributors: mockContributors,
        total: mockContributors.length,
        filtered: mockContributors.length,
      });

      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("dashboard-light.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });

    test("dashboard page - dark mode", async ({ context, page }) => {
      await page.emulateMedia({ colorScheme: "dark" });

      const maintainer = {
        id: "maintainer-mock",
        githubUsername: "lead-maintainer",
        name: "Lead Maintainer",
        isMaintainer: true,
      };

      await signInWithSessionCookie(context, maintainer);
      await mockMaintainerSession(page, maintainer);

      await interceptApi(page, "**/api/contributors*", {
        contributors: mockContributors,
        total: mockContributors.length,
        filtered: mockContributors.length,
      });

      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      await expect(page.locator("body")).toBeVisible();

      await expect(page).toHaveScreenshot("dashboard-dark.png", {
        fullPage: true,
        mask: dynamicMaskSelectors.map((sel) => page.locator(sel)),
        maxDiffPixelRatio: 0.05,
      });
    });
  });
});
