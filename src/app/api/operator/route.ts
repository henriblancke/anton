import { NextResponse } from "next/server";
import { resolveOperator } from "@/lib/operator";

export const dynamic = "force-dynamic";

/**
 * The human operator identity this anton instance claims as (ANTON_OPERATOR / global git
 * user.name). The board surfaces need it client-side to tell "mine" from "someone else's" when
 * rendering claim/release/steal controls — the same identity the claim route assigns to on POST.
 */
export async function GET() {
  const operator = await resolveOperator();
  return NextResponse.json({ operator: operator ?? null });
}
