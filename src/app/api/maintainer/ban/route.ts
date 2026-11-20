import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import {
  banContributor,
  unbanContributor,
  BanServiceError,
} from "@/lib/ban-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function banErrorResponse(error: unknown): NextResponse {
  if (error instanceof BanServiceError) {
    const status =
      error.code === "SELF_UNBAN_FORBIDDEN" || error.code === "SELF_BAN_FORBIDDEN"
        ? 403
        : error.code === "REASON_REQUIRED" || error.code === "INVALID_APPEAL_OUTCOME"
          ? 400
          : 500;
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status }
    );
  }
  const message =
    error instanceof Error ? error.message : "Failed to execute ban action.";
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * Maintainer endpoint for banning or unbanning a contributor by GitHub handle.
 * Requires maintainer session and a mandatory reason for bans.
 * Self-ban/self-unban is rejected with 403 + code (issue #660).
 */
export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Forbidden. Maintainer access required." },
      { status: 403 }
    );
  }

  try {
    const body = (await request.json()) as {
      action?: "ban" | "unban";
      githubUsername?: string;
      reason?: string;
      locale?: string;
    };

    const action = body.action ?? "ban";
    const githubUsername = body.githubUsername?.trim();
    const reason = body.reason?.trim();
    const locale = typeof body.locale === "string" ? body.locale : undefined;

    if (!githubUsername) {
      return NextResponse.json(
        { error: "githubUsername is required." },
        { status: 400 }
      );
    }

    if (action === "ban") {
      if (!reason) {
        return NextResponse.json(
          { error: "Reason is required to ban a contributor." },
          { status: 400 }
        );
      }

      const result = await banContributor({
        githubUsername,
        reason,
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
        locale,
      });

      await invalidateContributorListCaches();

      return NextResponse.json({
        success: true,
        message: `Contributor @${result.githubUsername} has been banned.`,
        details: result,
      });
    } else if (action === "unban") {
      const result = await unbanContributor({
        githubUsername,
        actorId: session.user.id,
        actorLogin: session.user.githubUsername ?? null,
        reason,
      });

      await invalidateContributorListCaches();

      return NextResponse.json({
        success: true,
        message: `Contributor @${result.githubUsername} has been unbanned.`,
        details: result,
      });
    } else {
      return NextResponse.json(
        { error: "Invalid action. Must be 'ban' or 'unban'." },
        { status: 400 }
      );
    }
  } catch (error) {
    return banErrorResponse(error);
  }
}
