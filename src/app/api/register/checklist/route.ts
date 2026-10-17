import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import type { OnboardingChecklistState } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Known checklist keys — used server-side to strip unknown fields from PATCH
 * payloads before persisting, keeping client and API state aligned.
 */
const KNOWN_CHECKLIST_KEYS: Array<keyof OnboardingChecklistState> = [
  "stellarAccountCreated",
  "usdcTrustlineAdded",
  "addressRegistered",
  "readinessConfirmed",
];

/** GET /api/register/checklist — return the user's persisted checklist state. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const registration = await prisma.registration.findUnique({
    where: { userId: session.user.id },
    select: { checklistCompleted: true },
  });

  const checklistCompleted =
    (registration?.checklistCompleted as OnboardingChecklistState | null) ?? {};

  return NextResponse.json({ checklistCompleted });
}

/**
 * PATCH /api/register/checklist — merge partial checklist updates.
 * Completed steps are never cleared; unknown keys are stripped to prevent
 * drift between the client model and the persisted record.
 */
export async function PATCH(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Record<string, unknown>;

  // Strip unknown keys — only merge recognised checklist fields.
  const incoming: OnboardingChecklistState = {};
  for (const key of KNOWN_CHECKLIST_KEYS) {
    if (typeof body[key] === "boolean") {
      incoming[key] = body[key] as boolean;
    }
  }

  const registration = await prisma.registration.findUnique({
    where: { userId: session.user.id },
    select: { checklistCompleted: true },
  });

  if (!registration) {
    return NextResponse.json(
      { error: "No registration found for this user" },
      { status: 404 }
    );
  }

  const existing =
    (registration.checklistCompleted as OnboardingChecklistState | null) ?? {};

  // Merge: completed steps from `existing` are preserved; `incoming` can only
  // set steps to true, never revert them to false.
  const merged: OnboardingChecklistState = { ...existing };
  for (const key of KNOWN_CHECKLIST_KEYS) {
    if (incoming[key] === true) {
      merged[key] = true;
    }
  }

  await prisma.registration.update({
    where: { userId: session.user.id },
    data: { checklistCompleted: merged },
  });

  return NextResponse.json({ checklistCompleted: merged });
}
