import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { checkStellarAddress } from "@/lib/horizon";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { toContributorRow } from "@/lib/registrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-service recheck endpoint for contributors to verify their own
 * Stellar address readiness. Applies retries, caching, and circuit breaker
 * protection via checkStellarAddress.
 *
 * E2E path (see docs/E2E_TESTING.md): readiness fail -> fund/trustline ->
 * Action recheck pass. The response always includes a stable `reasonCode`
 * so the UI and E2E tests can assert on the same vocabulary:
 *   - READY                 : funded + trustline ready
 *   - ACCOUNT_UNFUNDED      : account not yet funded on Horizon
 *   - ACCOUNT_NO_TRUSTLINE  : funded but missing/unauthorized trustline
 *   - ACCOUNT_LOW_BALANCE   : funded + trustline but below spendable minimum
 *   - HORIZON_UNAVAILABLE   : Horizon/network error (retryable)
 */
import { enforceFreezeWindowGuard } from "@/lib/freeze-window";
import { isUserBanned } from "@/lib/ban-service";

type RecheckReasonCode =
  | "READY"
  | "ACCOUNT_UNFUNDED"
  | "ACCOUNT_NO_TRUSTLINE"
  | "ACCOUNT_LOW_BALANCE"
  | "HORIZON_UNAVAILABLE";

function deriveReasonCode(result: {
  funded: boolean;
  trustline: boolean;
  trustline_authorized: boolean;
  spendable_xlm_balance: number;
}): RecheckReasonCode {
  if (!result.funded) return "ACCOUNT_UNFUNDED";
  if (!result.trustline || !result.trustline_authorized) {
    return "ACCOUNT_NO_TRUSTLINE";
  }
  if (result.spendable_xlm_balance <= 0) return "ACCOUNT_LOW_BALANCE";
  return "READY";
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if contributor is banned
  const banStatus = await isUserBanned(
    session.user.id,
    session.user.githubUsername ?? null
  );
  if (banStatus.banned) {
    return NextResponse.json(
      {
        error: `Account is suspended from recheck: ${banStatus.reason}`,
        code: "USER_BANNED",
      },
      { status: 403 }
    );
  }

  // Check wave freeze window
  const freezeGuard = await enforceFreezeWindowGuard({
    request,
    isMaintainer: Boolean(session.user.isMaintainer),
    userId: session.user.id,
    userLogin: session.user.githubUsername ?? null,
    actionLabel: "recheck",
  });
  if (freezeGuard.blocked && freezeGuard.response) {
    return freezeGuard.response;
  }

  try {
    // Find the contributor's existing registration
    const registration = await prisma.registration.findFirst({
      where: { userId: session.user.id },
      include: {
        user: {
          select: { githubUsername: true },
        },
      },
    });

    if (!registration) {
      return NextResponse.json(
        { error: "No registration found. Please register first." },
        { status: 404 }
      );
    }

    // Re-check the stellar address with retry and caching
    const horizonResult = await checkStellarAddress(
      registration.stellarAddress
    );

    // Update registration with latest check results
    const updated = await prisma.registration.update({
      where: { id: registration.id },
      data: {
        funded: horizonResult.funded,
        trustlineReady: horizonResult.trustline,
        trustlineAuthorized: horizonResult.trustline_authorized,
        xlmBalance: horizonResult.xlm_balance,
        spendableXlmBalance: horizonResult.spendable_xlm_balance,
        lastCheckedAt: new Date(),
      },
      include: {
        user: {
          select: { githubUsername: true },
        },
      },
    });

    const reasonCode = deriveReasonCode(horizonResult);

    // Record audit log for self-service recheck
    await recordAuditLog({
      action: "recheck.self_service",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: updated.id,
      targetLabel: updated.stellarAddress,
      metadata: {
        readiness: horizonResult.readiness,
        verified: horizonResult.verified,
        reasonCode,
      },
    });

    const contributorRow = toContributorRow(updated);

    return NextResponse.json({
      success: true,
      reasonCode,
      contributor: contributorRow,
      check: horizonResult,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to recheck registration";
    return NextResponse.json(
      { error: message, reasonCode: "HORIZON_UNAVAILABLE" },
      { status: 500 }
    );
  }
}
