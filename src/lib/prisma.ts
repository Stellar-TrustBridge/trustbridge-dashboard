import "server-only";

import { PrismaClient } from "@prisma/client";

import { isTracingEnabled, withSpan } from "@/lib/tracing";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// Opt-in query spans (issue #203). The middleware is registered once per
// client instance; the check is a cheap env read when tracing is off.
const tracedClient = prisma as PrismaClient & { __tracingMiddleware?: boolean };
if (!tracedClient.__tracingMiddleware) {
  tracedClient.__tracingMiddleware = true;
  prisma.$use(async (params, next) => {
    if (!isTracingEnabled()) return next(params);
    const model = params.model ?? "raw";
    return withSpan(`prisma.${model}.${params.action}`, () => next(params), {
      attributes: {
        "db.system": "postgresql",
        "db.model": model,
        "db.operation": params.action,
      },
    });
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
