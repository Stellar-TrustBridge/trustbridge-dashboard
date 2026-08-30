import { CheckCircle2, XCircle, AlertTriangle, RefreshCw } from "lucide-react";
import type { Metadata } from "next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { HealthResponse, HealthStatus } from "@/app/api/health/route";

export const metadata: Metadata = {
  title: "Status",
  description: "TrustBridge service status — dashboard, database, Horizon, and Soroban RPC.",
};

// Revalidate every 30 s to match the API cache TTL
export const revalidate = 30;

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const base =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
      "http://localhost:3000";
    const res = await fetch(`${base}/api/health`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<HealthResponse>;
  } catch {
    return null;
  }
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === "ok")
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />;
  if (status === "degraded")
    return <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />;
  return <XCircle className="h-4 w-4 text-destructive" aria-hidden />;
}

function StatusBadge({ status }: { status: HealthStatus }) {
  const variants: Record<HealthStatus, string> = {
    ok: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    degraded: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    error: "bg-destructive/15 text-destructive border-destructive/30",
  };
  const labels: Record<HealthStatus, string> = {
    ok: "Operational",
    degraded: "Degraded",
    error: "Outage",
  };
  return (
    <Badge className={`gap-1.5 ${variants[status]}`}>
      <StatusIcon status={status} />
      {labels[status]}
    </Badge>
  );
}

interface CheckRowProps {
  label: string;
  status: HealthStatus;
  detail?: string;
  latencyMs?: number;
}

function CheckRow({ label, status, detail, latencyMs }: CheckRowProps) {
  return (
    <div className="flex items-center justify-between py-3 border-b last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {detail && (
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {latencyMs !== undefined && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {latencyMs} ms
          </span>
        )}
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

export default async function StatusPage() {
  const health = await fetchHealth();

  if (!health) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl px-6 py-16 sm:px-8">
        <h1 className="text-2xl font-bold tracking-tight">Service status</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Unable to fetch status. The service may be starting up.
        </p>
      </main>
    );
  }

  const overallLabels: Record<HealthStatus, string> = {
    ok: "All systems operational",
    degraded: "Partial degradation",
    error: "Service disruption",
  };

  return (
    <main id="main-content" className="mx-auto max-w-2xl px-6 py-16 sm:px-8">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Service status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Last updated:{" "}
            <time dateTime={health.timestamp}>
              {new Date(health.timestamp).toLocaleTimeString(undefined, {
                timeStyle: "medium",
              })}
            </time>
          </p>
        </div>
        <StatusBadge status={health.status} />
      </div>

      {/* Overall banner */}
      <Card className="mb-6">
        <CardContent className="flex items-center gap-3 py-4">
          <StatusIcon status={health.status} />
          <p className="font-medium">{overallLabels[health.status]}</p>
        </CardContent>
      </Card>

      {/* Per-service checks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Components</CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-4">
          <CheckRow
            label="Dashboard"
            status={health.checks.database.status === "error" ? "error" : "ok"}
            detail="Next.js application"
          />
          <CheckRow
            label="Database"
            status={health.checks.database.status}
            latencyMs={health.checks.database.latencyMs}
            detail={
              health.checks.database.status === "error"
                ? "Connection failed"
                : undefined
            }
          />
          <CheckRow
            label="Horizon (Stellar)"
            status={health.checks.horizon.status}
            latencyMs={health.checks.horizon.latencyMs}
            detail="Used for trustline and balance checks"
          />
          <CheckRow
            label="Soroban RPC"
            status={health.checks.sorobanRpc.status}
            latencyMs={health.checks.sorobanRpc.latencyMs}
            detail="Used for on-chain contract events"
          />
          <CheckRow
            label="Data freshness"
            status={health.checks.csvStaleness.status}
            detail={
              health.checks.csvStaleness.status === "degraded"
                ? health.checks.csvStaleness.warning || "Contributor data may be stale"
                : `${health.checks.csvStaleness.totalCount} contributors tracked`
            }
          />
        </CardContent>
      </Card>

      <p className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="h-3 w-3" aria-hidden />
        Auto-refreshes every 30 seconds
      </p>
    </main>
  );
}
