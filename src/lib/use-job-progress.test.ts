/**
 * Tests for useJobProgress — SSE reconnect backoff and stale-state display.
 *
 * EventSource is a browser API not available in Node. We stub it with a minimal
 * controllable implementation so the hook's reconnect logic can be exercised
 * synchronously via vi.useFakeTimers().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJobProgress } from "./use-job-progress";

// ─── EventSource stub ──────────────────────────────────────────────────────

type EventSourceInstance = {
  url: string;
  onopen: ((e: Event) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  close: () => void;
  /** Test helper: push a parsed message event. */
  emitMessage: (data: object) => void;
  /** Test helper: trigger the error handler (simulates a dropped connection). */
  emitError: () => void;
};

let lastCreatedEs: EventSourceInstance | null = null;

function makeEventSourceStub(url: string): EventSourceInstance {
  const es: EventSourceInstance = {
    url,
    onopen: null,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    emitMessage(data: object) {
      this.onmessage?.({
        data: JSON.stringify(data),
      } as unknown as MessageEvent);
    },
    emitError() {
      this.onerror?.(new Event("error"));
    },
  };
  lastCreatedEs = es;
  return es;
}

// Install the stub before each test and restore after.
beforeEach(() => {
  lastCreatedEs = null;
  vi.useFakeTimers();
  // @ts-expect-error — overriding global for test purposes
  globalThis.EventSource = vi.fn().mockImplementation((url: string) =>
    makeEventSourceStub(url)
  );
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error
  delete globalThis.EventSource;
});

// ─── Helper ───────────────────────────────────────────────────────────────

function getCurrentEs(): EventSourceInstance {
  if (!lastCreatedEs) throw new Error("No EventSource created yet");
  return lastCreatedEs;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("useJobProgress — happy path", () => {
  it("starts streaming when startProgress is called", () => {
    const { result } = renderHook(() => useJobProgress());

    act(() => result.current.startProgress("job-1"));

    expect(result.current.activeJobId).toBe("job-1");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a progress event from the server", () => {
    const { result } = renderHook(() => useJobProgress());
    act(() => result.current.startProgress("job-1"));

    act(() => {
      getCurrentEs().emitMessage({
        type: "progress",
        jobId: "job-1",
        processed: 5,
        total: 10,
        errors: 0,
        done: false,
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    });

    expect(result.current.event?.type).toBe("progress");
    expect(result.current.event?.processed).toBe(5);
    expect(result.current.isReconnecting).toBe(false);
  });

  it("stops streaming and clears state on 'completed'", () => {
    const { result } = renderHook(() => useJobProgress());
    act(() => result.current.startProgress("job-1"));

    act(() => {
      getCurrentEs().emitMessage({
        type: "completed",
        jobId: "job-1",
        result: { summary: "done" },
        completedAt: "2026-10-01T00:01:00.000Z",
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.event?.type).toBe("completed");
    expect(result.current.error).toBeNull();
  });

  it("sets error and stops streaming on 'error' event", () => {
    const { result } = renderHook(() => useJobProgress());
    act(() => result.current.startProgress("job-2"));

    act(() => {
      getCurrentEs().emitMessage({
        type: "error",
        message: "Job not found",
      });
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.error).toBe("Job not found");
  });
});

describe("useJobProgress — reconnect backoff", () => {
  it("reconnects after the initial backoff delay when the connection drops", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 1000 })
    );

    act(() => result.current.startProgress("job-reconnect"));

    const firstEs = getCurrentEs();

    // Simulate a dropped connection (error on the EventSource).
    act(() => firstEs.emitError());

    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.isStreaming).toBe(true); // still "streaming" (recovering)

    // The first reconnect fires after 1000ms (attempt 1: 1000 * 1.5^0 = 1000ms).
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // A new EventSource must have been created.
    const secondEs = getCurrentEs();
    expect(secondEs).not.toBe(firstEs);

    // Receiving a message clears the reconnecting flag.
    act(() => {
      secondEs.emitMessage({
        type: "status",
        jobId: "job-reconnect",
        status: "processing",
        createdAt: "2026-10-01T00:00:00.000Z",
        startedAt: null,
      });
    });

    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);
  });

  it("increases the delay exponentially on consecutive failures", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 1000 })
    );

    act(() => result.current.startProgress("job-backoff"));

    // 1st drop
    act(() => getCurrentEs().emitError());
    expect(result.current.reconnectAttempt).toBe(1);

    // Advance past first delay (1000ms) but not into the second (1500ms).
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.reconnectAttempt).toBe(1);

    // 2nd drop (on the newly created EventSource)
    act(() => getCurrentEs().emitError());
    expect(result.current.reconnectAttempt).toBe(2);

    // Second backoff is 1000 * 1.5^1 = 1500ms. Advance just short — still reconnecting.
    act(() => vi.advanceTimersByTime(1400));
    expect(result.current.isReconnecting).toBe(true);

    // Advance the remaining 100ms to trigger the third EventSource.
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.reconnectAttempt).toBe(2); // counter sticks until message received
  });

  it("sets a permanent error and stops after maxReconnectAttempts exhausted", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 2, reconnectDelayMs: 500 })
    );

    act(() => result.current.startProgress("job-exhausted"));

    // Drop 1 → attempt 1
    act(() => getCurrentEs().emitError());
    act(() => vi.advanceTimersByTime(500)); // 500ms * 1.5^0

    // Drop 2 → attempt 2
    act(() => getCurrentEs().emitError());
    act(() => vi.advanceTimersByTime(750)); // 500ms * 1.5^1

    // Drop 3 — this is attempt 3, which exceeds maxReconnectAttempts (2).
    act(() => getCurrentEs().emitError());

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.error).toMatch(/reconnect/i);
  });
});

describe("useJobProgress — stale state display", () => {
  it("retains the last known event while reconnecting (stale state)", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 500 })
    );

    act(() => result.current.startProgress("job-stale"));

    // Push a progress event so the hook has stale data.
    act(() => {
      getCurrentEs().emitMessage({
        type: "progress",
        jobId: "job-stale",
        processed: 7,
        total: 20,
        errors: 0,
        done: false,
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    });

    expect(result.current.event?.processed).toBe(7);

    // Drop the connection.
    act(() => getCurrentEs().emitError());

    // While reconnecting the stale event is still accessible (not cleared).
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.event?.processed).toBe(7);
    expect(result.current.event?.type).toBe("progress");
  });
});

describe("useJobProgress — stopProgress", () => {
  it("stops streaming and cancels reconnection timers", () => {
    const { result } = renderHook(() =>
      useJobProgress({ maxReconnectAttempts: 3, reconnectDelayMs: 1000 })
    );

    act(() => result.current.startProgress("job-stop"));

    // Drop connection to trigger reconnect timer.
    act(() => getCurrentEs().emitError());
    expect(result.current.isReconnecting).toBe(true);

    // Cancel before the timer fires.
    act(() => result.current.stopProgress());

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.activeJobId).toBeNull();
    expect(result.current.reconnectAttempt).toBe(0);

    // Advancing the clock must NOT create a new EventSource.
    const esBefore = lastCreatedEs;
    act(() => vi.advanceTimersByTime(2000));
    expect(lastCreatedEs).toBe(esBefore);
  });
});
