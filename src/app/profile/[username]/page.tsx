import { notFound } from "next/navigation";
import { CheckCircle2, Clock, XCircle, AlertTriangle } from "lucide-react";
import type { Metadata } from "next";

import { prisma } from "@/lib/prisma";
import { computeReadiness } from "@/lib/readiness";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ReadinessStatus } from "@/types";

export const dynamic = "force-dynamic";

interface Props {
  params: { username: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `${params.username} — TrustBridge`,
    description: `TrustBridge readiness profile for @${params.username}`,
  };
}

function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  if (status === "ready") {
    return (
      <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Ready for payout
      </Badge>
    );
  }
  if (status === "low_reserve") {
    return (
      <Badge className="gap-1.5 bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        Low reserve
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5 bg-muted text-muted-foreground border-border">
      <XCircle className="h-3.5 w-3.5" aria-hidden />
      Not ready
    </Badge>
  );
}

export default async function PublicProfilePage({ params }: Props) {
  const { username } = params;

  // Validate username format before DB query
  if (!/^[a-zA-Z0-9_-]{1,39}$/.test(username)) {
    notFound();
  }

  const user = await prisma.user.findUnique({
    where: { githubUsername: username },
    select: {
      githubUsername: true,
      registration: {
        select: {
          profilePublic: true,
          showStellarAddress: true,
          stellarAddress: true,
          funded: true,
          trustlineReady: true,
          trustlineAuthorized: true,
          xlmBalance: true,
          spendableXlmBalance: true,
          lastCheckedAt: true,
          deletedAt: true,
        },
      },
    },
  });

  const reg = user?.registration;
  // Return 404 for any case that shouldn't be public — prevents user enumeration
  if (!user || !reg || reg.deletedAt || !reg.profilePublic) {
    notFound();
  }

  const readiness = computeReadiness(
    reg.funded,
    reg.trustlineReady,
    reg.xlmBalance,
    { authorized: reg.trustlineAuthorized, spendableBalance: reg.spendableXlmBalance }
  );

  return (
    <main className="mx-auto max-w-xl px-6 py-16 sm:px-8">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div>
              <CardTitle className="text-xl">@{user.githubUsername}</CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                TrustBridge contributor
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Readiness</span>
            <ReadinessBadge status={readiness} />
          </div>

          {reg.showStellarAddress && (
            <div className="flex items-start justify-between gap-4">
              <span className="shrink-0 text-sm text-muted-foreground">
                Stellar address
              </span>
              <code className="break-all text-right font-mono text-xs text-foreground">
                {reg.stellarAddress}
              </code>
            </div>
          )}

          {reg.lastCheckedAt && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Last checked</span>
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                {new Date(reg.lastCheckedAt).toLocaleDateString(undefined, {
                  dateStyle: "medium",
                })}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
