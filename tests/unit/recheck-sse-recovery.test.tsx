import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/dashboard/page";
import * as jobProgressHook from "@/lib/use-job-progress";
import * as paginatedHook from "@/lib/use-paginated-contributors";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock global fetch for background queries
global.fetch = vi.fn().mockImplementation((url: string) => {
  if (url.includes("/api/settings/freeze") || url.includes("/api/freeze-status")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ active: false }),
    });
  }
  if (url.includes("/api/settings/network")) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          horizonUrl: "https://horizon.stellar.org",
          assetCode: "USDC",
          assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          baseReserveXlm: 0.5,
          minXlmBalance: 1.5,
        }),
    });
  }
  if (url.includes("/api/soroban/events")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ events: [], errors: [] }),
    });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  });
});

describe("Dashboard SSE Recheck Disconnect Recovery UI", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(paginatedHook, "usePaginatedContributors").mockReturnValue({
      contributors: [],
      total: 0,
      pageIndex: 0,
      currentCursor: null,
      hasMore: false,
      hasPrev: false,
      isLoading: false,
      isError: false,
      goToNext: vi.fn(),
      goToPrev: vi.fn(),
      refetch: vi.fn(),
    });

    vi.spyOn(paginatedHook, "useAllContributors").mockReturnValue({
      contributors: [],
      total: 0,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("indicates SSE disconnect and reconnect attempt state in the UI", () => {
    vi.spyOn(jobProgressHook, "useJobProgress").mockReturnValue({
      activeJobId: "job-recheck-123",
      event: { type: "processing", jobId: "job-recheck-123" },
      isStreaming: true,
      isReconnecting: true,
      reconnectAttempt: 2,
      maxReconnectAttempts: 3,
      error: null,
      startProgress: vi.fn(),
      stopProgress: vi.fn(),
    });

    render(<DashboardPage />, { wrapper });

    // Reconnecting banner should be visible
    const reconnectBanner = screen.getByTestId("recheck-reconnecting-banner");
    expect(reconnectBanner).toBeInTheDocument();
    expect(reconnectBanner).toHaveTextContent(
      "Connection lost. Reconnecting to live recheck progress (attempt 2/3)..."
    );

    // Re-check button should show reconnecting status and be disabled
    const recheckButton = screen.getByRole("button", {
      name: /reconnecting \(2\/3\)\.\.\./i,
    });
    expect(recheckButton).toBeInTheDocument();
    expect(recheckButton).toBeDisabled();

    // Screen reader live status region
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Batch re-check: Reconnecting (2/3)..."
    );
  });

  it("displays disconnect error banner when reconnect fails", () => {
    vi.spyOn(jobProgressHook, "useJobProgress").mockReturnValue({
      activeJobId: "job-recheck-123",
      event: null,
      isStreaming: false,
      isReconnecting: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 3,
      error: "Connection lost. Failed to reconnect after 3 attempts.",
      startProgress: vi.fn(),
      stopProgress: vi.fn(),
    });

    render(<DashboardPage />, { wrapper });

    const errorBanner = screen.getByTestId("recheck-disconnect-error-banner");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent(
      "Batch recheck progress disconnected: Connection lost. Failed to reconnect after 3 attempts."
    );
  });

  it("resumes progress display and renders completion message on successful reconnect", () => {
    vi.spyOn(jobProgressHook, "useJobProgress").mockReturnValue({
      activeJobId: "job-recheck-123",
      event: {
        type: "completed",
        jobId: "job-recheck-123",
        result: { refreshed: 12 },
      },
      isStreaming: false,
      isReconnecting: false,
      reconnectAttempt: 0,
      maxReconnectAttempts: 3,
      error: null,
      startProgress: vi.fn(),
      stopProgress: vi.fn(),
    });

    render(<DashboardPage />, { wrapper });

    // No reconnect or error banners
    expect(screen.queryByTestId("recheck-reconnecting-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recheck-disconnect-error-banner")).not.toBeInTheDocument();

    // Completion banner
    expect(
      screen.getByText(/batch recheck completed\. 12 contributors refreshed\./i)
    ).toBeInTheDocument();
  });
});
