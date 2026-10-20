import * as React from "react";
import Link from "next/link";
import { BarChart3, Users, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface MetricsEmptyStateProps {
  title?: string;
  description?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function MetricsEmptyState({
  title = "No metrics recorded yet",
  description = "Contributors will appear here once they register and connect their Stellar wallets. System health and circuit breaker metrics update automatically.",
  onRefresh,
  isRefreshing,
}: MetricsEmptyStateProps) {
  return (
    <Card className="my-8 border-dashed" data-testid="metrics-empty-state">
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4 rounded-full bg-muted p-3 text-muted-foreground">
          <BarChart3 className="h-8 w-8" />
        </div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              Check again
            </Button>
          )}
          <Link href="/register">
            <Button size="sm" className="gap-1.5">
              <Users className="h-4 w-4" />
              Register contributor
            </Button>
          </Link>
          <a
            href="https://developers.stellar.org"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
          >
            Stellar documentation
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
