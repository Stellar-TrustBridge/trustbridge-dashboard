import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();
let mockPathname = "/dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

import { usePaginatedContributors } from "@/lib/use-paginated-contributors";

describe("usePaginatedContributors", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockPathname = "/dashboard";
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("hydrates initial cursor from URL searchParams on mount", () => {
    mockSearchParams = new URLSearchParams("cursor=cursor-page-2");

    const { result } = renderHook(() => usePaginatedContributors(10), { wrapper });

    expect(result.current.currentCursor).toBe("cursor-page-2");
    expect(result.current.hasPrev).toBe(false);
  });

  it("updates URL on goToNext", async () => {
    const fakeData = {
      contributors: [{ id: "1", githubUsername: "test1" }],
      total: 10,
      hasMore: true,
      nextCursor: "cursor-next-abc",
    };

    const { result } = renderHook(() => usePaginatedContributors(10), { wrapper });

    // Populate react-query cache for the current query
    queryClient.setQueryData(
      ["contributors", "paged", null, 10],
      fakeData
    );

    act(() => {
      result.current.goToNext();
    });

    expect(mockPush).toHaveBeenCalledWith("/dashboard?cursor=cursor-next-abc");
    expect(result.current.currentCursor).toBe("cursor-next-abc");
    expect(result.current.hasPrev).toBe(true);
    expect(result.current.pageIndex).toBe(1);
  });

  it("updates URL and pops cursor on goToPrev", () => {
    const fakeDataPage1 = {
      contributors: [{ id: "1" }],
      total: 20,
      hasMore: true,
      nextCursor: "cursor-2",
    };

    const { result } = renderHook(() => usePaginatedContributors(10), { wrapper });

    queryClient.setQueryData(["contributors", "paged", null, 10], fakeDataPage1);

    act(() => {
      result.current.goToNext();
    });

    expect(result.current.currentCursor).toBe("cursor-2");

    act(() => {
      result.current.goToPrev();
    });

    expect(mockPush).toHaveBeenLastCalledWith("/dashboard");
    expect(result.current.currentCursor).toBe(null);
    expect(result.current.hasPrev).toBe(false);
    expect(result.current.pageIndex).toBe(0);
  });
});
