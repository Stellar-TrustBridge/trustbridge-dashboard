import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { recordAuditLog } from "@/lib/audit";
import { authOptions } from "@/lib/auth";
import { isMaintainer } from "@/lib/maintainers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Basic XSS sanitizer stripping HTML tags from string.
 */
function sanitizeInput(str: string): string {
  return str.replace(/<[^>]*>?/gm, "").trim();
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await isMaintainer(session.user);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const registrationId = params.id;
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
  });

  if (!registration) {
    return NextResponse.json(
      { error: "Registration not found" },
      { status: 404 }
    );
  }

  try {
    const body = (await request.json()) as { notes?: string; tags?: string[] };
    let sanitizedNotes: string | null = null;
    let sanitizedTags: string[] = [];

    if (body.notes !== undefined && body.notes !== null) {
      const clean = sanitizeInput(body.notes);
      if (clean.length > 1000) {
        return NextResponse.json(
          { error: "Note exceeds 1,000 character limit" },
          { status: 400 }
        );
      }
      sanitizedNotes = clean;
    }

    if (Array.isArray(body.tags)) {
      if (body.tags.length > 10) {
        return NextResponse.json(
          { error: "Maximum 10 tags allowed" },
          { status: 400 }
        );
      }
      sanitizedTags = body.tags
        .map((tag) => sanitizeInput(String(tag)))
        .filter((tag) => tag.length > 0 && tag.length <= 30);
    }

    const updated = await prisma.registration.update({
      where: { id: registrationId },
      data: {
        notes: sanitizedNotes,
        tags: sanitizedTags,
      },
    });

    await recordAuditLog({
      action: "CONTRIBUTOR_NOTES_UPDATED",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: updated.id,
      targetLabel: updated.stellarAddress,
      metadata: {
        notesLength: sanitizedNotes?.length ?? 0,
        tagsCount: sanitizedTags.length,
      },
    });

    return NextResponse.json({
      success: true,
      registration: {
        id: updated.id,
        notes: updated.notes,
        tags: updated.tags,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update contributor notes" },
      { status: 500 }
    );
  }
}
