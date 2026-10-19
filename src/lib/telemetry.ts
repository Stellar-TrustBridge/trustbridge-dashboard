import "server-only";

/**
 * OpenTelemetry instrumentation for TrustBridge Dashboard.
 *
 * Provides lightweight tracing for critical operations like treasury exports,
 * horizon checks, and queue processing. When OTEL_EXPORTER_OTLP_ENDPOINT is
 * configured, spans are exported to a collector; otherwise, telemetry is
 * a no-op for zero overhead in development.
 */

export interface SpanAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Span {
  setStatus(status: { code: "OK" | "ERROR"; message?: string }): void;
  recordException(error: Error | string): void;
  end(): void;
  setAttribute(key: string, value: string | number | boolean): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span;
  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T>;
  startActiveSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: Span) => Promise<T>
  ): Promise<T>;
}

/**
 * No-op implementations when OpenTelemetry is disabled.
 */
class NoOpSpan implements Span {
  setStatus() {}
  recordException() {}
  end() {}
  setAttribute() {}
}

class NoOpTracer implements Tracer {
  startSpan(): Span {
    return new NoOpSpan();
  }

  startActiveSpan<T>(
    _name: string,
    attributesOrFn: SpanAttributes | ((span: Span) => Promise<T>),
    fn?: (span: Span) => Promise<T>
  ): Promise<T> {
    const actualFn = typeof attributesOrFn === "function" ? attributesOrFn : fn!;
    const span = new NoOpSpan();
    return actualFn(span);
  }
}

/**
 * Real OpenTelemetry span wrapping @opentelemetry/api.
 * Only instantiated when OTEL is actually enabled.
 */
class RealSpan implements Span {
  constructor(private otelSpan: any) {}

  setStatus(status: { code: "OK" | "ERROR"; message?: string }): void {
    this.otelSpan.setStatus({
      code: status.code === "OK" ? 1 : 2, // SpanStatusCode.OK = 1, ERROR = 2
      message: status.message,
    });
  }

  recordException(error: Error | string): void {
    const err = typeof error === "string" ? new Error(error) : error;
    this.otelSpan.recordException(err);
  }

  end(): void {
    this.otelSpan.end();
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.otelSpan.setAttribute(key, value);
  }
}

/**
 * Real OpenTelemetry tracer using @opentelemetry/api.
 */
class RealTracer implements Tracer {
  private otelTracer: any;

  constructor(private api: any) {
    this.otelTracer = api.trace.getTracer("trustbridge-dashboard", "0.1.0");
  }

  startSpan(name: string, attributes?: SpanAttributes): Span {
    const otelSpan = this.otelTracer.startSpan(name, {
      attributes: attributes ?? {},
    });
    return new RealSpan(otelSpan);
  }

  startActiveSpan<T>(
    name: string,
    attributesOrFn: SpanAttributes | ((span: Span) => Promise<T>),
    fn?: (span: Span) => Promise<T>
  ): Promise<T> {
    const attributes = typeof attributesOrFn === "function" ? {} : attributesOrFn;
    const actualFn = typeof attributesOrFn === "function" ? attributesOrFn : fn!;

    return this.api.context.with(
      this.api.trace.setSpan(this.api.context.active(), this.otelTracer.startSpan(name, { attributes })),
      async () => {
        const span = this.api.trace.getActiveSpan();
        const wrappedSpan = new RealSpan(span);
        try {
          const result = await actualFn(wrappedSpan);
          wrappedSpan.setStatus({ code: "OK" });
          return result;
        } catch (error) {
          wrappedSpan.setStatus({
            code: "ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
          wrappedSpan.recordException(error instanceof Error ? error : String(error));
          throw error;
        } finally {
          wrappedSpan.end();
        }
      }
    );
  }
}

let cachedTracer: Tracer | null = null;

/**
 * Returns a tracer instance. If OTEL_EXPORTER_OTLP_ENDPOINT is set,
 * returns a real tracer backed by @opentelemetry/api; otherwise returns
 * a no-op tracer with zero overhead.
 */
export function getTracer(): Tracer {
  if (cachedTracer) return cachedTracer;

  const otelEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

  if (!otelEnabled) {
    cachedTracer = new NoOpTracer();
    return cachedTracer;
  }

  try {
    // Dynamic import to avoid bundling OpenTelemetry when not used
    const api = require("@opentelemetry/api");
    cachedTracer = new RealTracer(api);
    console.log("[Telemetry] OpenTelemetry enabled with OTLP endpoint");
    return cachedTracer;
  } catch {
    console.warn(
      "[Telemetry] @opentelemetry/api not installed, falling back to no-op tracer"
    );
    cachedTracer = new NoOpTracer();
    return cachedTracer;
  }
}

/**
 * Convenience wrapper for instrumenting async operations with automatic
 * error handling and status tracking.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, attributes, fn);
}
