/**
 * Tests for src/components/UpdatePrompt.tsx
 *
 * Covers:
 *   Happy path  — banner shows via forceShow, reload button posts SKIP_WAITING
 *   Failure #1  — dismiss button hides the banner without reloading
 *   Failure #2  — banner stays hidden when no waiting SW and forceShow is unset
 *   Edge case   — reload falls back to window.location.reload() when no waitingSW
 *
 * The SW lifecycle (serviceWorker.ready, updatefound, statechange,
 * controllerchange) is exercised separately in integration; here we focus on
 * the component's observable behaviour via props and DOM interactions.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdatePrompt } from "@/components/UpdatePrompt";

// ---------------------------------------------------------------------------
// Navigator / window mocks
// ---------------------------------------------------------------------------

const mockPostMessage = vi.fn();
const mockReload = vi.fn();

// A minimal ServiceWorker stub with a postMessage function.
function makeWaitingSW(): ServiceWorker {
  return { postMessage: mockPostMessage } as unknown as ServiceWorker;
}

// serviceWorker.ready resolves with a registration that has no waiting SW
// by default; individual tests override `reg.waiting` as needed.
let mockRegistration: Partial<ServiceWorkerRegistration>;

beforeEach(() => {
  mockRegistration = {
    waiting: null,
    installing: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  };

  // jsdom does not implement serviceWorker; stub the minimum surface.
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
      controller: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload: mockReload },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path — banner is visible via forceShow
// ---------------------------------------------------------------------------

describe("UpdatePrompt — happy path (forceShow)", () => {
  it("renders the update banner when forceShow is true", () => {
    render(<UpdatePrompt forceShow />);
    expect(screen.getByTestId("update-prompt")).toBeInTheDocument();
    expect(screen.getByText(/new version/i)).toBeInTheDocument();
  });

  it("renders a Reload button and a Later/dismiss button", () => {
    render(<UpdatePrompt forceShow />);
    expect(screen.getByTestId("update-prompt-reload")).toBeInTheDocument();
    expect(screen.getByTestId("update-prompt-dismiss")).toBeInTheDocument();
  });

  it("has role='status' and aria-live='polite' for screen-reader announcement", () => {
    render(<UpdatePrompt forceShow />);
    const banner = screen.getByTestId("update-prompt");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("calls window.location.reload when Reload is clicked and no waitingSW is known", () => {
    // forceShow bypasses the SW state; no waitingSW is set, so the reload
    // path falls back to window.location.reload().
    render(<UpdatePrompt forceShow />);
    fireEvent.click(screen.getByTestId("update-prompt-reload"));
    expect(mockReload).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Failure path #1 — dismiss hides the banner
// ---------------------------------------------------------------------------

describe("UpdatePrompt — dismiss hides the banner", () => {
  it("removes the banner when the Later button is clicked", async () => {
    render(<UpdatePrompt forceShow />);

    // Banner is visible initially.
    expect(screen.getByTestId("update-prompt")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("update-prompt-dismiss"));
    });

    // Banner disappears after dismissal.
    expect(screen.queryByTestId("update-prompt")).not.toBeInTheDocument();
  });

  it("does NOT reload the page when dismissed", async () => {
    render(<UpdatePrompt forceShow />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("update-prompt-dismiss"));
    });
    expect(mockReload).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure path #2 — banner absent with no waiting SW and forceShow unset
// ---------------------------------------------------------------------------

describe("UpdatePrompt — hidden when no update is pending", () => {
  it("renders nothing by default (no forceShow, no waiting SW)", async () => {
    // The serviceWorker.ready resolves with no waiting SW.
    const { container } = render(<UpdatePrompt />);
    // Let the effect settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("update-prompt")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Reload posts SKIP_WAITING to a known waiting SW
// ---------------------------------------------------------------------------

describe("UpdatePrompt — Reload triggers SKIP_WAITING via postMessage", () => {
  it("posts SKIP_WAITING when a waiting SW is detected via forceShow + real SW flow", async () => {
    // We exercise the postMessage path by mounting with forceShow and
    // manually injecting a waiting SW reference through serviceWorker.ready.
    const waitingSW = makeWaitingSW();
    mockRegistration.waiting = waitingSW;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(mockRegistration as ServiceWorkerRegistration),
        controller: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    render(<UpdatePrompt forceShow />);
    // Wait for the useEffect to process the ready promise and set waitingSW.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("update-prompt-reload"));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(mockReload).not.toHaveBeenCalled();
  });
});
