"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, ShieldCheck, Users, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WaveReadinessBar } from "@/components/WaveReadinessBar";
import { HorizonLatencyChart } from "@/components/HorizonLatencyChart";
import { AddressAnomalyBanner } from "@/components/AddressAnomalyBanner";
import type { HorizonLatencyStats } from "@/lib/stats";
import type { AnomalyStatus } from "@/lib/address-anomaly";

// ── API response types ────────────────────────────────────────────────────

interface MetricsResponse {
  contributors: {
    total: number;
    ready: number;
    readyPercent: number;
    byStatus: {
      ready: number;
      low_reserve: number;
      not_ready: number;
    };
  };
  horizonLatency?: HorizonLatencyStats;
  addressAnomaly?: AnomalyStatus;
  audit: {
    recentEntries: number;
    byAction: Record<string, number>;
    latestAt: string | null;
  };
  config: {
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    circuitBreakerFailureThreshold: number;
    circuitBreakerRecoveryMs: number;
    staleCsvMaxAgeMs: number;
    horizonUrl: string;
    sorobanContractConfigured: boolean;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function msToSeconds(ms: number) {
  return (ms / 1000).toFixed(0);
}

function msToHours(ms: number) {
  return (ms / 3_600_000).toFixed(1);
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function MetricsPage() {
  const metricsQuery = useQuery<MetricsResponse>({
    queryKey: ["admin-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/metrics");
      if (!res.ok) throw new Error("Failed to load metrics");
      return res.json();
    },
  });

  if (metricsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading metrics…
      </div>
    );
  }

  if (metricsQuery.isError) {
    return (
      <p
        className="my-8 rounded-lg border border-destructive/60 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        Failed to load metrics. Make sure you are signed in as a maintainer.
      </p>
    );
  }

  const data = metricsQuery.data!;
  const { contributors, audit, config } = data;
  const auditEntries = Object.entries(audit.byAction).sort((a, b) => b[1] - a[1]);

  return (
    <div
      className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10"
      data-testid="metrics-page"
    >
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Admin metrics</h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            Real-time operational snapshot for the TrustBridge maintainer team.
          </p>
        </div>
        <Button
          variant="outline"
          size="lg"
          className="w-full sm:w-auto"
          onClick={() => metricsQuery.refetch()}
          disabled={metricsQuery.isFetching}
        >
          {metricsQuery.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {/* ── Security Anomaly Alert ────────────────────────────── */}
      <AddressAnomalyBanner status={data.addressAnomaly} />

      {/* ── Contributor readiness ─────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Contributor readiness
          </CardTitle>
          <CardDescription>
            Current payout readiness across all {contributors.total} registered
            contributors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <WaveReadinessBar
            readyCount={contributors.ready}
            totalCount={contributors.total}
          />
          {/* Dark mode: -300 heading + -200 sub-label on dark:bg-*-950/40 gives
              ≥ 7:1 contrast against the page background (WCAG AAA).
              Light mode: -700 on white/tinted bg gives ≥ 6.5:1 (WCAG AA). */}
          <div className="grid grid-cols-1 gap-3 text-center sm:grid-cols-3 sm:gap-4">
            <div className="min-h-11 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-4 dark:border-emerald-600 dark:bg-emerald-950/40">
              <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                {contributors.byStatus.ready}
              </p>
              <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-200">
                ✅ Ready
              </p>
            </div>
            <div className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 dark:border-amber-600 dark:bg-amber-950/40">
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                {contributors.byStatus.low_reserve}
              </p>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
                ⚠️ Low reserve
              </p>
            </div>
            <div className="min-h-11 rounded-lg border border-red-300 bg-red-50 px-4 py-4 dark:border-red-600 dark:bg-red-950/40">
              <p className="text-2xl font-bold text-red-700 dark:text-red-300">
                {contributors.byStatus.not_ready}
              </p>
              <p className="mt-1 text-xs text-red-700 dark:text-red-200">
                ❌ Not ready
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Horizon API Latency ─────────────────────────────────── */}
      <HorizonLatencyChart stats={data.horizonLatency} />

      {/* ── Recent audit activity ─────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Recent audit activity
          </CardTitle>
          <CardDescription>
            Last {audit.recentEntries} audit log entries
            {audit.latestAt
              ? ` — latest at ${new Date(audit.latestAt).toLocaleString()}`
              : ""}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No audit events recorded yet.
            </p>
          ) : (
            <>
              <ul
                className="space-y-3 sm:hidden"
                aria-label="Audit log entry counts by action, most frequent first"
                data-testid="metrics-audit-mobile"
              >
                {auditEntries.map(([action, count]) => (
                  <li
                    key={action}
                    className="min-h-11 rounded-lg border border-border-strong px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <span className="font-mono text-xs">{action}</span>
                      <span className="tabular-nums font-medium">{count}</span>
                    </div>
                  </li>
                ))}
              </ul>

              <div
                className="hidden overflow-x-auto sm:block"
                data-testid="metrics-audit-table"
              >
                <table className="w-full min-w-[320px] text-sm">
                  <caption className="sr-only">
                    Audit log entry counts by action, most frequent first.
                  </caption>
                  <thead>
                    <tr className="border-b-2 border-border-strong text-left text-muted-foreground">
                      <th scope="col" className="pb-2 font-medium">
                        Action
                      </th>
                      <th scope="col" className="pb-2 text-right font-medium">
                        Count
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map(([action, count]) => (
                      <tr
                        key={action}
                        className="border-b border-border-strong last:border-0"
                      >
                        <th
                          scope="row"
                          className="py-3 text-left font-mono text-xs font-normal"
                        >
                          {action}
                        </th>
                        <td className="py-3 text-right tabular-nums">{count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Operational config ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Operational configuration
          </CardTitle>
          <CardDescription>
            Live values for rate limiting, circuit breaker, and export staleness.
            Set via environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <ConfigRow
              label="Rate limit window"
              value={`${msToSeconds(config.rateLimitWindowMs)}s`}
              hint="RATE_LIMIT_WINDOW_MS"
            />
            <ConfigRow
              label="Rate limit max requests"
              value={String(config.rateLimitMaxRequests)}
              hint="RATE_LIMIT_MAX_REQUESTS"
            />
            <ConfigRow
              label="Circuit breaker threshold"
              value={`${config.circuitBreakerFailureThreshold} failures`}
              hint="HORIZON_CB_FAILURE_THRESHOLD"
            />
            <ConfigRow
              label="Circuit breaker recovery"
              value={`${msToSeconds(config.circuitBreakerRecoveryMs)}s`}
              hint="HORIZON_CB_RECOVERY_MS"
            />
            <ConfigRow
              label="Stale CSV max age"
              value={`${msToHours(config.staleCsvMaxAgeMs)}h`}
              hint="STALE_CSV_MAX_AGE_MS"
            />
            <ConfigRow
              label="Horizon URL"
              value={config.horizonUrl}
              hint="NEXT_PUBLIC_HORIZON_URL"
            />
            <ConfigRow
              label="Soroban contract"
              value={config.sorobanContractConfigured ? "Configured ✅" : "Not set ⚠️"}
              hint="SOROBAN_CONTRACT_ID"
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-h-11 rounded-md border border-border-strong px-3 py-3 sm:py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      {/* Full-strength muted foreground: the env-var name is the part a
          maintainer copies, so it should not be the faintest thing on screen. */}
      <dd className="mt-0.5 font-mono text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}
