import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/settings/api-keys/[id]
 * Revoke (soft-delete) a single API key by id.
 * The row is retained for audit purposes; `revokedAt` is set to now.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json(
      { error: "Forbidden: maintainer access required" },
      { status: 403 }
    );
  }

  const { id } = params;

  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  if (existing.revokedAt) {
    return NextResponse.json(
      { error: "API key is already revoked" },
      { status: 409 }
    );
  }

  const revoked = await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
    select: {
      id: true,
      name: true,
      scopes: true,
      createdAt: true,
      revokedAt: true,
    },
  });

  return NextResponse.json({ apiKey: revoked });
}
