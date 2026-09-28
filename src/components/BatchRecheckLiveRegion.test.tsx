import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BatchRecheckLiveRegion } from "@/components/BatchRecheckLiveRegion";
import type { JobProgressEvent } from "@/lib/use-job-progress";

describe("BatchRecheckLiveRegion", () => {
  it("announces progress politely without repeating per-event details", () => {
    const { rerender } = render(
      <BatchRecheckLiveRegion
        event={{ type: "processing", startedAt: "2026-09-27T12:00:00Z" }}
        isStarting={false}
        isStreaming={true}
        error={null}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Batch re-check in progress.");

    rerender(
      <BatchRecheckLiveRegion
        event={{ type: "processing", startedAt: "2026-09-27T12:00:01Z" }}
        isStarting={false}
        isStreaming={true}
        error={null}
      />
    );

    expect(status).toHaveTextContent("Batch re-check in progress.");
    expect(status).not.toHaveTextContent("%");
  });

  it.each([
    {
      event: {
        type: "completed",
        result: { refreshed: 12 },
      } as JobProgressEvent,
      expected: "Batch re-check completed. 12 contributors refreshed.",
    },
    {
      event: { type: "failed", error: "Queue unavailable" } as JobProgressEvent,
      expected: "Batch re-check failed: Queue unavailable",
    },
  ])("announces terminal event: $expected", ({ event, expected }) => {
    render(
      <BatchRecheckLiveRegion
        event={event}
        isStarting={false}
        isStreaming={false}
        error={null}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });
});