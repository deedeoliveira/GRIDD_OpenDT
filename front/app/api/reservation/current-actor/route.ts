import { NextResponse } from "next/server";

export async function GET() {
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/reservation/current-actor`, { cache: "no-store" });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: "Current application actor is unavailable." }, { status: 503 });
  }
}
