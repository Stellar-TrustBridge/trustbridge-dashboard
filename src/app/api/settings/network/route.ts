import { NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { getNetworkConfig } from "@/lib/network-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Maintainer-only view of the resolved Horizon/Soroban network
 * configuration. Records an audit entry when a mismatch is detected so
 * there is a durable trail even if nobody happens to be looking at the
 * dashboard when a misconfiguration ships.
 *
 * Also performs a dual-write audit whenever the resolved RPC URL changes
 * relative to the last observed value. Because env vars are build-time for
 * NEXT_PUBLIC_* and runtime for server-side vars, the "last seen" state is
 * stored in an in-process variable and re-evaluated on every cold start.
 * This is best-effort (process-local), which is intentional: the route is
 * read-only and the network can only be changed via env vars + redeploy.
 * The audit trail is therefore coarse-grained — one entry per process
 * lifetime that sees a new value — rather than per-request noise.
 */

let lastObservedRpcState: {
  horizonUrl: string;
  sorobanUrl: string;
} | null = null;

/** Test-only: reset the in-process RPC-change tracker. */
export function _resetRpcState(): void {
  lastObservedRpcState = null;
}

export async function GET() {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const config = getNetworkConfig();

  // --- Audit: network mismatch ---
  if (config.mismatched) {
    await recordAuditLog({
      action: "network_config_mismatch_detected",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetLabel: "network-config",
      metadata: {
        horizonNetwork: config.horizonNetwork,
        sorobanNetwork: config.sorobanNetwork,
        horizonUrl: config.horizonUrl,
        sorobanUrl: config.sorobanUrl,
      },
    });
  }

  // --- Audit: RPC URL change (dual-write) ---
  // Redact credentials from URLs before storing or logging them so a
  // scheme://user:pass@host connection string never reaches the audit log.
  const safeHorizonUrl = redactUrlCredentials(config.horizonUrl ?? "");
  const safeSorobanUrl = redactUrlCredentials(config.sorobanUrl ?? "");

  if (lastObservedRpcState !== null) {
    const horizonChanged = lastObservedRpcState.horizonUrl !== safeHorizonUrl;
    const sorobanChanged = lastObservedRpcState.sorobanUrl !== safeSorobanUrl;

    if (horizonChanged || sorobanChanged) {
      await recordAuditLog({
        action: "settings.network.rpc_url_changed",
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
        targetLabel: "network-config",
        metadata: {
          ...(horizonChanged && {
            horizonUrl: { from: lastObservedRpcState.horizonUrl, to: safeHorizonUrl },
          }),
          ...(sorobanChanged && {
            sorobanUrl: { from: lastObservedRpcState.sorobanUrl, to: safeSorobanUrl },
          }),
          horizonNetwork: config.horizonNetwork,
          sorobanNetwork: config.sorobanNetwork,
        },
      });
    }
  }

  lastObservedRpcState = { horizonUrl: safeHorizonUrl, sorobanUrl: safeSorobanUrl };

  return NextResponse.json(config);
}

/**
 * Strip inline credentials from a URL string before it enters the audit log.
 * Returns the original string unchanged when it is not a valid URL or carries
 * no credentials.
 */
function redactUrlCredentials(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "[redacted]";
      parsed.password = "[redacted]";
      return parsed.toString();
    }
  } catch {
    // Not a parseable URL — return as-is
  }
  return url;
}
