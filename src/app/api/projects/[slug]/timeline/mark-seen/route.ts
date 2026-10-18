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
 * How far past the server's own clock a mark may name, in seconds.
 *
 * The contract above — post the `until` you were handed — makes a mark ahead of this server's clock
 * a sign the caller used its own instead, and that is the one error this write cannot absorb: the
 * watermark never moves back, so a mark minted from a fast clock buries every event up to it
 * permanently, including the ones that have not happened yet. Refused rather than clamped to `now`,
 * which would report the instant the caller named as stored. The tolerance covers the seconds of
 * skew between any two real clocks; beyond it the caller is not answering a window anton issued.
 */
const FUTURE_TOLERANCE_SEC = 120;

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

  const nowSec = Math.floor(systemClock.now() / 1000);
  if (parsed.data.seenAt > nowSec + FUTURE_TOLERANCE_SEC) {
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
