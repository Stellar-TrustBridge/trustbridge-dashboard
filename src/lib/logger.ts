import { NextRequest, NextResponse } from "next/server";

export interface StructuredLog {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  context: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/**
 * Structured logging utility for request/response tracking and debugging.
 * Logs are emitted to stdout in JSON format for aggregation and analysis.
 *
 * Pass a `requestId` to the constructor (or via `withRequestId()`) to include
 * the ID in every log entry emitted by that instance — making it trivial to
 * grep all entries belonging to a single HTTP request.
 */
export class StructuredLogger {
  private context: string;
  private requestId?: string;

  constructor(context: string, requestId?: string) {
    this.context = context;
    this.requestId = requestId;
  }

  /**
   * Return a new logger that is identical to this one but carries the given
   * request ID. Useful when you need to hand off a scoped logger to a helper.
   */
  withRequestId(requestId: string): StructuredLogger {
    return new StructuredLogger(this.context, requestId);
  }

  private formatLog(
    level: StructuredLog["level"],
    message: string,
    details?: Record<string, unknown>
  ): StructuredLog {
    const entry: StructuredLog = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
    };
    if (this.requestId) {
      entry.requestId = this.requestId;
    }
    if (details !== undefined) {
      entry.details = details;
    }
    return entry;
  }

  info(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("info", message, details);
    console.log(JSON.stringify(log));
  }

  warn(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("warn", message, details);
    console.warn(JSON.stringify(log));
  }

  error(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("error", message, details);
    console.error(JSON.stringify(log));
  }

  debug(message: string, details?: Record<string, unknown>) {
    const log = this.formatLog("debug", message, details);
    const debugFlag = process.env.DEBUG?.trim().toLowerCase();
    // Treat unset / empty / explicit falsey values as off; only truthy flags enable debug.
    if (debugFlag && debugFlag !== "0" && debugFlag !== "false" && debugFlag !== "off") {
      console.log(JSON.stringify(log));
    }
  }
}

/**
 * Serialize an unknown thrown value into a plain, log-friendly shape so that
 * structured log entries never lose the underlying error information.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/**
 * Middleware for logging incoming requests with structured format.
 * Logs method, path, origin, and user agent.
 */
export function createRequestLogger(context: string) {
  const logger = new StructuredLogger(context);

  return function logRequest(request: NextRequest) {
    const method = request.method;
    const pathname = request.nextUrl.pathname;
    const searchParams = request.nextUrl.searchParams.toString();
    const userAgent = request.headers.get("user-agent") ?? "unknown";
    const origin = request.headers.get("origin") ?? "unknown";

    logger.info("incoming_request", {
      method,
      pathname,
      searchParams: searchParams ? searchParams : undefined,
      userAgent,
      origin,
    });
  };
}

/**
 * Log API response with status, duration, and optional error details.
 */
export function logResponse(
  logger: StructuredLogger,
  response: NextResponse,
  duration: number,
  details?: Record<string, unknown>
) {
  logger.info("outgoing_response", {
    status: response.status,
    duration: `${duration}ms`,
    ...details,
  });
}

/**
 * Log Horizon API call with request/response details.
 */
export function logHorizonCall(
  logger: StructuredLogger,
  method: string,
  endpoint: string,
  duration: number,
  success: boolean,
  error?: string
) {
  if (success) {
    logger.info("horizon_request_success", {
      method,
      endpoint,
      duration: `${duration}ms`,
    });
  } else {
    logger.error("horizon_request_failed", {
      method,
      endpoint,
      duration: `${duration}ms`,
      error,
    });
  }
}

/**
 * Log database query with operation type and duration.
 */
export function logDatabaseQuery(
  logger: StructuredLogger,
  operation: string,
  duration: number,
  rowsAffected?: number
) {
  logger.debug("database_query", {
    operation,
    duration: `${duration}ms`,
    rowsAffected,
  });
}
