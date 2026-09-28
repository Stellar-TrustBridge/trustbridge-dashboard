import { NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/registrations/deleted
 *
 * Returns the 50 most recently soft-deleted registrations so maintainers can
 * find and restore accidentally deleted rows. Maintainer session required.
 */
export async function GET() {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const deleted = await prisma.registration.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    take: 50,
    include: {
      user: { select: { githubUsername: true, githubAvatarUrl: true } },
    },
  });

  return NextResponse.json({ registrations: deleted });
}
