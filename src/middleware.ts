import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import {
  getMaintenanceMessage,
  shouldBlockForMaintenance,
} from "@/lib/maintenance";

/**
 * RBAC path rules (default deny):
 *
 * /dashboard          -> viewer+
 * /dashboard/settings -> operator+
 * /register           -> authenticated (any role)
 * /api/contributors   -> operator+ (POST = admin-only for batch recheck)
 * /api/invites        -> admin-only
 */
export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const isMaintainer = token?.isMaintainer;
    const role = (token?.role as string | undefined) ?? (isMaintainer ? "viewer" : undefined);
    const path = req.nextUrl.pathname;

    // Maintenance mode (issue #202): during a deploy, mutating API requests are
    // rejected with a 503 while reads stay up. `/api/auth`, `/api/webhooks` and
    // `/api/health` are exempt (see src/lib/maintenance.ts). The kill switch is
    // the env var only, so a bad DB can't strand maintainers.
    //
    // Deliberately no audit write here: maintenance mode often coincides with a
    // migration, and a blocked client retrying would amplify writes against a
    // database that may be mid-deploy. The 503 response is the signal.
    if (shouldBlockForMaintenance(req.method, path)) {
      return NextResponse.json(
        { error: "maintenance_mode", message: getMaintenanceMessage() },
        { status: 503, headers: { "Retry-After": "120" } }
      );
    }

    // /dashboard requires viewer+
    if (path.startsWith("/dashboard")) {
      if (!isMaintainer) {
        const redirectResponse = NextResponse.redirect(
          new URL("/register?error=maintainer", req.url)
        );
        redirectResponse.headers.set("x-request-id", requestId);
        return redirectResponse;
      }

      // /dashboard/settings requires operator+
      if (path.startsWith("/dashboard/settings") && role !== "admin" && role !== "operator") {
        recordAuditLog({
          action: "rbac_middleware_denied",
          metadata: { path, requiredRole: "operator", actualRole: role },
        }).catch(() => {});
        const redirectResponse = NextResponse.redirect(
          new URL("/dashboard?error=insufficient_role", req.url)
        );
        redirectResponse.headers.set("x-request-id", requestId);
        return redirectResponse;
      }
    }

    // /api/invites requires admin
    if (path.startsWith("/api/invites")) {
      if (!isMaintainer || (role !== "admin" && role !== undefined)) {
        // Only admin can access invites
        if (role !== "admin") {
          recordAuditLog({
            action: "rbac_middleware_denied",
            metadata: { path, requiredRole: "admin", actualRole: role },
          }).catch(() => {});
          const forbiddenResponse = NextResponse.json(
            { error: "Forbidden" },
            { status: 403 }
          );
          forbiddenResponse.headers.set("x-request-id", requestId);
          return forbiddenResponse;
        }
      }
    }

    // Pass the request ID forward in both request headers (for server-side
    // handlers to read via headers()) and response headers (for clients to
    // log or display in error UIs).
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set("x-request-id", requestId);
    return response;
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const path = req.nextUrl.pathname;

        if (path.startsWith("/dashboard")) {
          return !!token;
        }

        if (path.startsWith("/register")) {
          return !!token;
        }

        return true;
      },
    },
  }
);

export const config = {
  // `/api/:path*` is matched so maintenance mode can 503 mutating API calls.
  // The `authorized` callback returns true for API paths, so this does not add
  // an auth gate — each route keeps doing its own authorization.
  matcher: [
    "/dashboard/:path*",
    "/register/:path*",
    // All API routes except NextAuth's own endpoints, so maintenance mode can
    // 503 mutating calls without wrapping the auth flow.
    "/api/((?!auth).*)",
  ],
};