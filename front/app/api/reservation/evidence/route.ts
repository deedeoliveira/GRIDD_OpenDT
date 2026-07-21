import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/reservation/evidence`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(await req.json()),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Semantic evidence service is unavailable." }, { status: 503 });
  }
}

