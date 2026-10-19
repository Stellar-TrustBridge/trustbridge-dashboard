import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContributorTable } from "@/components/ContributorTable";
import type { ContributorRow } from "@/types";

const mockContributors: ContributorRow[] = [
  {
    id: "1",
    githubUsername: "alice",
    stellarAddress: "GAALICE",
    readiness: "ready",
    verified: true,
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "100",
    spendableXlmBalance: "95",
    lastCheckedAt: new Date().toISOString(),
    banned: false,
    banReason: null,
  },
  {
    id: "2",
    githubUsername: "bob",
    stellarAddress: "GABBOB",
    readiness: "not_ready",
    verified: false,
    funded: false,
    trustlineReady: false,
    trustlineAuthorized: false,
    xlmBalance: "0",
    spendableXlmBalance: "0",
    lastCheckedAt: new Date().toISOString(),
    banned: false,
    banReason: null,
  },
  {
    id: "3",
    githubUsername: "charlie",
    stellarAddress: "GACCHARLIE",
    readiness: "low_reserve",
    verified: true,
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "5",
    spendableXlmBalance: "1",
    lastCheckedAt: new Date().toISOString(),
    banned: false,
    banReason: null,
  },
];

describe("ContributorTable Search Debounce and A11y", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("should debounce search input", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    // Type quickly
    await user.type(searchInput, "ali");

    // Should show "filtering..." immediately
    expect(screen.getByText(/filtering…/i)).toBeInTheDocument();

    // Before 300ms, should not have filtered
    expect(screen.getByText(/3 contributors/i)).toBeInTheDocument();

    // Fast-forward past debounce delay
    vi.advanceTimersByTime(300);

    // Should now show filtered results
    await waitFor(() => {
      expect(screen.getByText(/1 of 3 contributors matching "ali"/i)).toBeInTheDocument();
    });
  });

  it("should announce search results to screen readers", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    await user.type(searchInput, "bob");

    // Fast-forward debounce
    vi.advanceTimersByTime(300);

    // Check for a11y live region announcement
    await waitFor(() => {
      const liveRegion = screen.getByRole("status", { hidden: true });
      expect(liveRegion).toHaveTextContent(/Found 1 contributor matching "bob"/i);
    });
  });

  it("should announce multiple results with plural form", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    await user.type(searchInput, "G");

    vi.advanceTimersByTime(300);

    await waitFor(() => {
      const liveRegion = screen.getByRole("status", { hidden: true });
      expect(liveRegion).toHaveTextContent(/Found 3 contributors matching "G"/i);
    });
  });

  it("should show searching indicator during debounce", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    await user.type(searchInput, "test");

    // Should show searching indicator immediately
    const liveRegion = screen.getByRole("status", { hidden: true });
    expect(liveRegion).toHaveTextContent(/Searching contributors…/i);

    vi.advanceTimersByTime(300);

    // After debounce, searching indicator should be replaced
    await waitFor(() => {
      expect(liveRegion).not.toHaveTextContent(/Searching contributors…/i);
    });
  });

  it("should clear search result announcement when search is cleared", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    // Type and wait
    await user.type(searchInput, "alice");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
        /Found 1 contributor/i
      );
    });

    // Clear search
    await user.clear(searchInput);
    vi.advanceTimersByTime(300);

    // Announcement should be empty
    await waitFor(() => {
      const liveRegion = screen.getByRole("status", { hidden: true });
      expect(liveRegion).toHaveTextContent("");
    });
  });

  it("should reset debounce timer on each keystroke", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    await user.type(searchInput, "a");
    vi.advanceTimersByTime(150);

    await user.type(searchInput, "l");
    vi.advanceTimersByTime(150);

    // Should still be searching (timer reset)
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      /Searching/i
    );

    vi.advanceTimersByTime(150);

    // Now it should be done
    await waitFor(() => {
      expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
        /Found 1 contributor matching "al"/i
      );
    });
  });

  it("should handle no results gracefully", async () => {
    const user = userEvent.setup({ delay: null });

    render(<ContributorTable contributors={mockContributors} />);

    const searchInput = screen.getByLabelText(
      /Search contributors by GitHub username/i
    );

    await user.type(searchInput, "nonexistent");
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
        /Found 0 contributors matching "nonexistent"/i
      );
    });

    expect(
      screen.getByText(/No contributors match "nonexistent"/i)
    ).toBeInTheDocument();
  });
});
