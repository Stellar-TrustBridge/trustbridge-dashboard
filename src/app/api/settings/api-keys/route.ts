import { createHash, randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All recognised scope values. */
export const VALID_SCOPES = [
  "treasury:read",
  "treasury:export",
  "contributors:read",
  "contributors:write",
] as const;

export type ApiKeyScope = (typeof VALID_SCOPES)[number];

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * GET /api/settings/api-keys
 * Returns all API keys (without the raw key — it is shown only once at
 * creation time).
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Forbidden: maintainer access required" },
      { status: 403 }
    );
  }

  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      scopes: true,
      createdAt: true,
      revokedAt: true,
    },
  });

  return NextResponse.json({ keys });
}

/**
 * POST /api/settings/api-keys
 * Create a new API key.  The raw key is returned exactly once in the
 * `rawKey` field — it is never stored and cannot be recovered afterwards.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Forbidden: maintainer access required" },
      { status: 403 }
    );
  }

  const body = (await request.json()) as { name?: string; scopes?: string[] };

  // Validate name
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json(
      { error: "API key name is required" },
      { status: 400 }
    );
  }

  // Validate scopes
  const requestedScopes: string[] = Array.isArray(body.scopes)
    ? body.scopes
    : [];
  const invalidScopes = requestedScopes.filter(
    (s) => !(VALID_SCOPES as readonly string[]).includes(s)
  );
  if (invalidScopes.length > 0) {
    return NextResponse.json(
      { error: `Invalid scopes: ${invalidScopes.join(", ")}` },
      { status: 400 }
    );
  }

  // Generate raw key — shown exactly once, never persisted.
  const rawKey = `tb_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashKey(rawKey);

  const apiKey = await prisma.apiKey.create({
    data: {
      name,
      keyHash,
      scopes: requestedScopes as ApiKeyScope[],
    },
    select: {
      id: true,
      name: true,
      scopes: true,
      createdAt: true,
      revokedAt: true,
    },
  });

  return NextResponse.json(
    {
      apiKey,
      // The raw key is returned exactly once here. The client must store it.
      rawKey,
    },
    { status: 201 }
  );
}
