import { NextRequest, NextResponse } from "next/server";

import { requireOperator } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { computeReadiness } from "@/lib/readiness";
import { recordAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TreasuryExportItem {
  githubUsername: string;
  stellarAddress: string;
  readiness: "ready" | "low_reserve" | "not_ready";
  funded: boolean;
  trustlineReady: boolean;
  trustlineAuthorized: boolean;
  xlmBalance: string;
  spendableXlmBalance: string;
  lastCheckedAt: string | null;
}

interface TreasuryExportResponse {
  exportedAt: string;
  exportedBy: string;
  totalContributors: number;
  readyCount: number;
  notReadyCount: number;
  contributors: TreasuryExportItem[];
}

export async function GET() {
  const session = await requireOperator("treasury.export");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const registrations = await prisma.registration.findMany({
    where: { deletedAt: null },
    include: {
      user: {
        select: {
          githubUsername: true,
        },
      },
    },
  });

  const contributors: TreasuryExportItem[] = [];
  let readyCount = 0;
  let notReadyCount = 0;

  for (const reg of registrations) {
    const readiness = computeReadiness(
      reg.funded,
      reg.trustlineReady,
      reg.xlmBalance,
      {
        authorized: reg.trustlineAuthorized,
        spendableBalance: reg.spendableXlmBalance,
      }
    );

    contributors.push({
      githubUsername: reg.user.githubUsername,
      stellarAddress: reg.stellarAddress,
      readiness,
      funded: reg.funded,
      trustlineReady: reg.trustlineReady,
      trustlineAuthorized: reg.trustlineAuthorized,
      xlmBalance: reg.xlmBalance,
      spendableXlmBalance: reg.spendableXlmBalance,
      lastCheckedAt: reg.lastCheckedAt?.toISOString() ?? null,
    });

    if (readiness === "ready") {
      readyCount++;
    } else {
      notReadyCount++;
    }
  }

  await recordAuditLog({
    action: "treasury.export",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      totalContributors: contributors.length,
      readyCount,
      notReadyCount,
    },
  });

  const response: TreasuryExportResponse = {
    exportedAt: new Date().toISOString(),
    exportedBy: session.user.email ?? session.user.githubUsername ?? "",
    totalContributors: contributors.length,
    readyCount,
    notReadyCount,
    contributors,
  };

  return NextResponse.json(response);
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireOperator("treasury.export");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as { format?: string };
  const format = body.format ?? "json";

  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: "Unsupported export format" },
      { status: 400 }
    );
  }

  const registrations = await prisma.registration.findMany({
    where: { deletedAt: null },
    include: {
      user: {
        select: {
          githubUsername: true,
        },
      },
    },
  });

  const contributors: TreasuryExportItem[] = [];
  let readyCount = 0;
  let notReadyCount = 0;

  for (const reg of registrations) {
    const readiness = computeReadiness(
      reg.funded,
      reg.trustlineReady,
      reg.xlmBalance,
      {
        authorized: reg.trustlineAuthorized,
        spendableBalance: reg.spendableXlmBalance,
      }
    );

    contributors.push({
      githubUsername: reg.user.githubUsername,
      stellarAddress: reg.stellarAddress,
      readiness,
      funded: reg.funded,
      trustlineReady: reg.trustlineReady,
      trustlineAuthorized: reg.trustlineAuthorized,
      xlmBalance: reg.xlmBalance,
      spendableXlmBalance: reg.spendableXlmBalance,
      lastCheckedAt: reg.lastCheckedAt?.toISOString() ?? null,
    });

    if (readiness === "ready") {
      readyCount++;
    } else {
      notReadyCount++;
    }
  }

  await recordAuditLog({
    action: "treasury.export",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    metadata: {
      totalContributors: contributors.length,
      readyCount,
      notReadyCount,
      format,
    },
  });

  if (format === "csv") {
    const headers = [
      "github_username",
      "stellar_address",
      "readiness",
      "funded",
      "trustline_ready",
      "trustline_authorized",
      "xlm_balance",
      "spendable_xlm_balance",
      "last_checked_at",
    ];

    const rows = contributors.map((c) => [
      c.githubUsername,
      c.stellarAddress,
      c.readiness,
      c.funded,
      c.trustlineReady,
      c.trustlineAuthorized,
      c.xlmBalance,
      c.spendableXlmBalance,
      c.lastCheckedAt ?? "",
    ]);

    const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="treasury-export-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  }

  const response: TreasuryExportResponse = {
    exportedAt: new Date().toISOString(),
    exportedBy: session.user.email ?? session.user.githubUsername ?? "",
    totalContributors: contributors.length,
    readyCount,
    notReadyCount,
    contributors,
  };

  return NextResponse.json(response);
}
