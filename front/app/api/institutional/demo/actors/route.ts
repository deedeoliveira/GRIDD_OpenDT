import { NextResponse } from "next/server";

export async function GET() {
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/institutional/demo/actors`, { cache: "no-store" });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ ok: false, code: "institutional_api_unavailable", message: "Institutional demo is unavailable" }, { status: 503 });
  }
}
