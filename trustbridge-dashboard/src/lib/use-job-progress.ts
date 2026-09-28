"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface JobProgressState {
  jobId: string | null;
  status: "idle" | "connecting" | "running" | "completed" | "failed" | "disconnected";
  processed: number;
  total: number;
  percent: number;
  message: string | null;
  error: string | null;
}

export interface JobProgressEvent {
  jobId?: string;
  processed?: number;
  total?: number;
  percent?: number;
  status?: JobProgressState["status"];
  message?: string;
  error?: string;
}

export interface UseJobProgressOptions {
  /** Base URL for the SSE endpoint. Defaults to the contributors queue progress route. */
  url?: string;
  /** Automatically connect when a jobId is provided. Defaults to true. */
  autoConnect?: boolean;
  /** Called whenever a progress event is applied. */
  onProgress?: (state: JobProgressState) => void;
  /** Called when the stream reports completion. */
  onComplete?: (state: JobProgressState) => void;
  /** Called when the stream reports an error or disconnects. */
  onError?: (error: string) => void;
}

const DEFAULT_URL = "/api/contributors/queue/progress";

const initialState: JobProgressState = {
  jobId: null,
  status: "idle",
  processed: 0,
  total: 0,
  percent: 0,
  message: null,
  error: null,
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function computePercent(processed: number, total: number, explicit?: number): number {
  if (typeof explicit === "number") return clampPercent(explicit);
  if (total > 0) return clampPercent((processed / total) * 100);
  return 0;
}

/**
 * Subscribes to server-sent progress events for a recheck job.
 *
 * Applies progress updates from SSE message events, resets state on
 * disconnect/error so the UI can recover, and closes the underlying
 * EventSource on unmount.
 */
export function useJobProgress(
  jobId: string | null,
  options: UseJobProgressOptions = {},
) {
  const { url = DEFAULT_URL, autoConnect = true, onProgress, onComplete, onError } = options;

  const [state, setState] = useState<JobProgressState>(initialState);
  const sourceRef = useRef<EventSource | null>(null);

  const callbacksRef = useRef({ onProgress, onComplete, onError });
  callbacksRef.current = { onProgress, onComplete, onError };

  const close = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const applyEvent = useCallback((event: JobProgressEvent) => {
    setState((prev) => {
      const processed = typeof event.processed === "number" ? event.processed : prev.processed;
      const total = typeof event.total === "number" ? event.total : prev.total;
      const percent = computePercent(processed, total, event.percent);
      const status = event.status ?? prev.status;

      const next: JobProgressState = {
        jobId: event.jobId ?? prev.jobId,
        status,
        processed,
        total,
        percent,
        message: event.message ?? prev.message,
        error: event.error ?? (status === "failed" ? prev.error : null),
      };

      callbacksRef.current.onProgress?.(next);
      if (next.status === "completed") callbacksRef.current.onComplete?.(next);
      if (next.status === "failed" && next.error) callbacksRef.current.onError?.(next.error);

      return next;
    });
  }, []);

  const connect = useCallback(
    (id: string) => {
      close();

      if (typeof EventSource === "undefined") {
        setState((prev) => ({
          ...prev,
          jobId: id,
          status: "failed",
          error: "EventSource is not supported in this environment",
        }));
        return null;
      }

      setState((prev) => ({
        ...prev,
        jobId: id,
        status: "connecting",
        error: null,
      }));

      const source = new EventSource(`${url}?jobId=${encodeURIComponent(id)}`);
      sourceRef.current = source;

      source.onopen = () => {
        setState((prev) => ({ ...prev, status: "running", error: null }));
      };

      source.onmessage = (event: MessageEvent<string>) => {
        if (!event.data) return;
        try {
          const parsed = JSON.parse(event.data) as JobProgressEvent;
          applyEvent(parsed);
        } catch {
          // Ignore malformed payloads; keep the stream alive.
        }
      };

      source.onerror = () => {
        close();
        setState((prev) => ({
          ...prev,
          status: "disconnected",
          error: prev.error ?? "Progress stream disconnected",
        }));
        callbacksRef.current.onError?.("Progress stream disconnected");
      };

      return source;
    },
    [applyEvent, close, url],
  );

  const disconnect = useCallback(() => {
    close();
    setState((prev) => ({ ...prev, status: "idle" }));
  }, [close]);

  const reset = useCallback(() => {
    close();
    setState(initialState);
  }, [close]);

  useEffect(() => {
    if (!jobId || !autoConnect) return;
    connect(jobId);
    return () => {
      close();
    };
  }, [jobId, autoConnect, connect, close]);

  useEffect(() => close, [close]);

  return { ...state, connect, disconnect, reset };
}

export default useJobProgress;
