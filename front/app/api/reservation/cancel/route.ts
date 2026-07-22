import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const cookie = request.headers.get("cookie");
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/reservation/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(await request.json()),
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "The reservation service is unavailable." }, { status: 503 });
  }
}
