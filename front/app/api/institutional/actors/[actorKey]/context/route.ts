import { NextResponse } from "next/server";

export async function GET(_request: Request, { params }: { params: Promise<{ actorKey: string }> }) {
  const { actorKey } = await params;
  try {
    const response = await fetch(
      `${process.env.BASE_API_URL}/institutional/actors/${encodeURIComponent(actorKey)}/context`,
      { cache: "no-store" }
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ ok: false, code: "institutional_api_unavailable", message: "Institutional context is unavailable" }, { status: 503 });
  }
}
