import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const backendUrl = `${process.env.BASE_API_URL}/reservation/checkin`;

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(req.headers.get("cookie") ? { cookie: req.headers.get("cookie")! } : {}) },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);

    return NextResponse.json(data, { status: response.status });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, message: error.message },
      { status: 500 }
    );
  }
}
