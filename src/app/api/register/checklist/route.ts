import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import {
  buildCacheKey,
  buildNoCacheControl,
  checklistIdempotencyCache,
} from "@/lib/cache";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import {
  type OnboardingChecklistKey,
  type OnboardingChecklistState,
  parseChecklistState,
} from "@/types";
import { captureException } from "@/lib/sentry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Known checklist keys — used server-side to strip unknown fields from flat
 * PATCH payloads before persisting, keeping client and API state aligned.
 */
const KNOWN_CHECKLIST_KEYS: Array<OnboardingChecklistKey> = [
  "stellarAccountCreated",
  "usdcTrustlineAdded",
  "addressRegistered",
  "readinessConfirmed",
];

/** Idempotency support for double-clicks/retries of the checklist PATCH. */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** 8–128 chars: UUIDs, hashes and opaque client-generated tokens all fit. */
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

/** Org + user + client key, escaped so no component can spoof a separator. */
function buildChecklistIdempotencyCacheKey(
  orgId: string,
  userId: string,
  key: string
): string {
  return buildCacheKey(
    "checklist:idem",
    encodeURIComponent(orgId),
    encodeURIComponent(userId),
    key
  );
}

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

const VALID_STEP_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_STEPS_ALLOWED = 50;

type ChecklistUpdatesResult =
  | { valid: true; updates: OnboardingChecklistState }
  | { valid: false; updates: OnboardingChecklistState; error: string };

/**
 * Validate an incoming checklist update payload.
 *
 * Three shapes are accepted:
 * - Single-step toggle: `{ stepId: string, completed: boolean }`.
 * - Multi-step update: `{ steps: Record<string, boolean> }` or
 *   `{ checklistCompleted: Record<string, boolean> }`.
 * - Flat map of canonical fields: `{ addressRegistered: true, ... }` —
 *   only known keys are kept, unknown keys are stripped.
 *
 * Step keys must match VALID_STEP_REGEX (prevents PII/injection) and values
 * must be booleans so only valid boolean state is stored.
 */
function parseChecklistUpdates(body: unknown): ChecklistUpdatesResult {
  if (!body || typeof body !== "object") {
    return { valid: false, updates: {}, error: "Invalid request payload" };
  }

  const payload = body as Record<string, unknown>;

  // Case 1: single-step toggle { stepId: string, completed: boolean }
  if ("stepId" in payload) {
    const stepId = payload.stepId;
    const completed = payload.completed;

    if (typeof stepId !== "string" || !VALID_STEP_REGEX.test(stepId)) {
      return { valid: false, updates: {}, error: "Invalid stepId format" };
    }
    if (typeof completed !== "boolean") {
      return {
        valid: false,
        updates: {},
        error: "completed must be a boolean",
      };
    }

    return { valid: true, updates: { [stepId]: completed } };
  }

  // Case 2: multi-step update { steps } or { checklistCompleted }
  if (payload.steps !== undefined || payload.checklistCompleted !== undefined) {
    const stepsCandidate = (payload.steps ??
      payload.checklistCompleted) as Record<string, unknown>;

    if (
      typeof stepsCandidate !== "object" ||
      stepsCandidate === null ||
      Array.isArray(stepsCandidate)
    ) {
      return {
        valid: false,
        updates: {},
        error: "Checklist steps must be an object",
      };
    }

    const entries = Object.entries(stepsCandidate);
    if (entries.length > MAX_STEPS_ALLOWED) {
      return {
        valid: false,
        updates: {},
        error: "Too many checklist steps",
      };
    }

    const updates: OnboardingChecklistState = {};
    for (const [key, val] of entries) {
      if (!VALID_STEP_REGEX.test(key)) {
        return {
          valid: false,
          updates: {},
          error: `Invalid step key: ${key}`,
        };
      }
      if (typeof val !== "boolean") {
        return {
          valid: false,
          updates: {},
          error: `Value for ${key} must be a boolean`,
        };
      }
      updates[key] = val;
    }

    return { valid: true, updates };
  }

  // Case 3: flat map of canonical checklist fields — strip unknown keys.
  const updates: OnboardingChecklistState = {};
  for (const key of KNOWN_CHECKLIST_KEYS) {
    if (typeof payload[key] === "boolean") {
      updates[key] = payload[key] as boolean;
    }
  }

  return { valid: true, updates };
}

/**
 * PATCH /api/register/checklist
 *
 * Persists onboarding checklist step completion for the signed-in user.
 * Merges updates with existing state (user + registration) to prevent
 * multi-tab stomps and to never wipe previously completed steps.
 */
export async function PATCH(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Idempotency is opt-in: requests without a key keep the existing behavior.
  const rawIdempotencyKey = request.headers
    .get(IDEMPOTENCY_KEY_HEADER)
    ?.trim();
  let idempotencyKey: string | null = null;
  let idempotencyCacheKey: string | null = null;

  if (rawIdempotencyKey !== undefined) {
    if (!IDEMPOTENCY_KEY_REGEX.test(rawIdempotencyKey)) {
      return NextResponse.json(
        {
          error:
            "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]",
        },
        { status: 400 }
      );
    }

    idempotencyKey = rawIdempotencyKey;
    const orgId = session.user.maintainerOrgId?.trim() || "default";
    idempotencyCacheKey = buildChecklistIdempotencyCacheKey(
      orgId,
      session.user.id,
      idempotencyKey
    );

    const replay = checklistIdempotencyCache.get(idempotencyCacheKey);
    if (replay) {
      return NextResponse.json(replay.body, {
        status: replay.status,
        headers: {
          "Idempotency-Key": idempotencyKey,
          "X-Idempotent-Replay": "true",
          "Cache-Control": buildNoCacheControl(),
        },
      });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload" },
      { status: 400 }
    );
  }

  const parsed = parseChecklistUpdates(body);
  if (!parsed.valid) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const userId = session.user.id;

  // Fetch existing checklist state from the user record and/or registration.
  const [user, registration] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { checklistCompleted: true },
    }),
    prisma.registration.findUnique({
      where: { userId },
      select: { id: true, deletedAt: true, checklistCompleted: true },
    }),
  ]);

  if (!registration) {
    return NextResponse.json(
      { error: "No registration found for this user" },
      { status: 404 }
    );
  }

  const merged: OnboardingChecklistState = {
    ...parseChecklistState(user?.checklistCompleted),
    ...parseChecklistState(registration.checklistCompleted),
    ...parsed.updates,
  };

  // Persist to the User record and the active Registration atomically.
  try {
    const dbOperations: Array<Promise<unknown>> = [
      prisma.user.update({
        where: { id: userId },
        data: { checklistCompleted: merged },
      }),
    ];

    if (!registration.deletedAt) {
      dbOperations.push(
        prisma.registration.update({
          where: { id: registration.id },
          data: { checklistCompleted: merged },
        })
      );
    }

    await Promise.all(dbOperations);
  } catch (err) {
    captureException(err, {
      route: "/api/register/checklist",
      method: "PATCH",
      userId,
    });

    return NextResponse.json(
      { error: "Failed to update checklist" },
      { status: 500 }
    );
  }

  const responseBody = { success: true as const, checklistCompleted: merged };

  if (idempotencyCacheKey && idempotencyKey) {
    checklistIdempotencyCache.set(idempotencyCacheKey, {
      status: 200,
      body: responseBody,
    });
    return NextResponse.json(responseBody, {
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Cache-Control": buildNoCacheControl(),
      },
    });
  }

  return NextResponse.json(responseBody);
}
