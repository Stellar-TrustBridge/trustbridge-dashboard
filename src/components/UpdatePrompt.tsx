"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * UpdatePrompt
 *
 * Shows a banner when a new service worker is waiting to take control —
 * i.e. a new deployment has been downloaded in the background and is ready
 * to activate. The user can dismiss the banner (defer the update) or click
 * "Reload" to let the new SW claim the page immediately via `skipWaiting()`.
 *
 * Implementation notes:
 * - Registers a `controllerchange` listener so the tab refreshes
 *   automatically once the new SW claims clients (after skipWaiting).
 * - Tracks the waiting SW via `navigator.serviceWorker.ready` + the
 *   `updatefound` / `statechange` lifecycle events.
 * - `forceShow` lets tests render the visible state without a real SW.
 * - Never renders on the server (client component, reads navigator).
 * - `data-testid="update-prompt"` enables reliable E2E / unit targeting.
 *
 * Security notes:
 * - `postMessage({ type: "SKIP_WAITING" })` is the only message sent to the
 *   SW; the SW must check `event.data.type === "SKIP_WAITING"` before acting.
 * - No API calls or sensitive data flow through this component.
 *
 * @see docs/PWA.md — "Update prompt" section.
 */

export interface UpdatePromptProps {
  /**
   * Override for Storybook / tests: render the banner without a real SW.
   * Production call sites omit this.
   */
  forceShow?: boolean;
}

export function UpdatePrompt({ forceShow }: UpdatePromptProps = {}) {
  const [waitingSW, setWaitingSW] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;

    const handleUpdateFound = () => {
      const newSW = registration?.installing;
      if (!newSW) return;

      newSW.addEventListener("statechange", () => {
        if (newSW.state === "installed" && navigator.serviceWorker.controller) {
          // A new SW installed alongside an already-controlling one means
          // there is an update waiting to activate.
          setWaitingSW(newSW);
        }
      });
    };

    navigator.serviceWorker.ready
      .then((reg) => {
        registration = reg;

        // Handle a waiting SW that was already installed before this component mounted
        // (e.g. the tab was open before the deploy and the SW already finished installing).
        if (reg.waiting && navigator.serviceWorker.controller) {
          setWaitingSW(reg.waiting);
        }

        reg.addEventListener("updatefound", handleUpdateFound);

        // Poll for updates (the SW update check runs on page focus / navigate
        // but is never guaranteed in SPAs with no hard navigations).
        reg.update().catch(() => {
          // Swallow — update() can legitimately fail in dev (HTTP) or when
          // the SW registration is not yet settled.
        });
      })
      .catch(() => {
        // serviceWorker.ready rejects if the page is in an insecure context
        // (non-HTTPS, localhost without special flags). Safe to ignore.
      });

    // When the SW controller changes (i.e. the new SW activated after
    // skipWaiting), reload the page to load fresh assets.
    const handleControllerChange = () => {
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange
    );

    return () => {
      registration?.removeEventListener("updatefound", handleUpdateFound);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange
      );
    };
  }, []);

  const handleReload = () => {
    if (waitingSW) {
      waitingSW.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  const show = forceShow ?? (waitingSW !== null && !dismissed);

  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-prompt"
      className="flex items-center justify-between gap-4 border-b border-blue-400 bg-blue-100 px-4 py-2 text-sm font-medium text-blue-900 dark:border-blue-600 dark:bg-blue-950 dark:text-blue-100"
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          A new version of TrustBridge is available. Reload to get the latest.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleReload}
          data-testid="update-prompt-reload"
          className="rounded bg-blue-700 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          Reload
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          data-testid="update-prompt-dismiss"
          aria-label="Dismiss update notification"
          className="rounded px-2 py-1 text-xs text-blue-700 hover:text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 dark:text-blue-300 dark:hover:text-blue-100"
        >
          Later
        </button>
      </div>
    </div>
  );
}
