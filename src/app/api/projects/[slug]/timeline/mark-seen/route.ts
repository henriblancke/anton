import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { markSeen } from "@/lib/viewer-marks";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Epoch seconds the viewer has read up to — the `until` the events-since read handed them. */
  seenAt: z.number().int().min(0),
});

/**
 * Mark this project's timeline read up to an instant (anton-z8j4q).
 *
 * The watermark only ever moves FORWARD, and the store settles that rather than this route: an
 * earlier `seenAt` answers 200 with `moved: false` and the mark that still stands. A no-op, not a
 * rejection — a stale tab posting the watermark it loaded with has done nothing wrong, it simply has
 * nothing to contribute, and a 409 there would put an error in front of an operator who only clicked
 * the button they were shown.
 *
 * Callers should post the `until` from the read they are answering, never their own clock: `until`
 * is the window they were actually shown, and marking past it would bury events nobody saw.
 */
export const POST = withProject<{ slug: string }>(async (request, { project }) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { seenAt } as epoch seconds (a non-negative integer)" },
      { status: 400 },
    );
  }

  // A legitimate `seenAt` is an `until` this same server minted in an earlier GET, so by the time
  // the POST lands it can never be ahead of the server's own (monotonically advancing) clock. Any
  // tolerance here is a window where a fast client clock buries events that have not happened yet
  // behind an irreversible watermark, so this is capped at `nowSec` exactly rather than clamped —
  // clamping would silently store a time the caller never actually answered.
  const nowSec = Math.floor(systemClock.now() / 1000);
  if (parsed.data.seenAt > nowSec) {
    return NextResponse.json(
      {
        error:
          `seenAt is ${parsed.data.seenAt - nowSec}s ahead of this server — post the ` +
          `\`until\` from the read you are answering, since a mark cannot be moved back`,
      },
      { status: 400 },
    );
  }

  const { mark, moved } = await markSeen(getDb(), systemClock, {
    projectId: project.id,
    seenAt: parsed.data.seenAt,
  });

  return NextResponse.json({ mark, moved });
});
