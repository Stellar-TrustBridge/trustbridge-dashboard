import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import {
  FEATURE_FLAG_KEYS,
  getAllFeatureFlags,
  flagSourceLabel,
  setFeatureFlag,
  type FeatureFlagKey,
} from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireMaintainer() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return {
      session: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!session.user.isMaintainer) {
    return {
      session: null,
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { session, error: null };
}

/**
 * GET /api/settings/feature-flags
 *
 * Returns a list of all resolved feature flags with descriptions,
 * resolved statuses (taking into account env overrides and DB state),
 * and human-readable source labels.
 *
 * Restricted to authenticated maintainers.
 */
export async function GET() {
  const { error } = await requireMaintainer();
  if (error) return error;

  const resolvedFlags = await getAllFeatureFlags();

  const flags = resolvedFlags.map((flag) => ({
    key: flag.key,
    enabled: flag.enabled,
    value: flag.enabled,
    source: flagSourceLabel(flag.source),
    description: flag.description,
  }));

  return NextResponse.json(
    { flags },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}

/**
 * POST /api/settings/feature-flags
 *
 * Toggle a flag in the database source. Requires same-origin (CSRF) and an
 * authenticated maintainer session — the flags API cannot be toggled without
 * auth (issue #661). Body: `{ key: FeatureFlagKey, enabled: boolean }`.
 */
export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const { session, error } = await requireMaintainer();
  if (error) return error;

  let body: { key?: unknown; enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { key, enabled } = body;
  if (
    typeof key !== "string" ||
    !FEATURE_FLAG_KEYS.includes(key as FeatureFlagKey)
  ) {
    return NextResponse.json(
      {
        error: `Unknown feature flag. Expected one of: ${FEATURE_FLAG_KEYS.join(", ")}.`,
      },
      { status: 400 }
    );
  }
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean." },
      { status: 400 }
    );
  }

  try {
    await setFeatureFlag(key as FeatureFlagKey, enabled, session!.user.id);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update feature flag.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    key,
    enabled,
    updatedBy: session!.user.id,
  });
}
