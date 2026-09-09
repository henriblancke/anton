import { NextResponse } from "next/server";
import { fetchGatewayModelIds } from "@/lib/claude/gateway-models";
import { getProjectSettingsBySlug } from "@/lib/projects";

export const dynamic = "force-dynamic";

/** Lists the configured gateway's models without ever serializing its token to the settings client. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const models = await fetchGatewayModelIds(await getProjectSettingsBySlug(slug));
    return NextResponse.json({ models });
  } catch {
    return NextResponse.json({ error: "Could not retrieve models from the configured gateway" }, { status: 502 });
  }
}
