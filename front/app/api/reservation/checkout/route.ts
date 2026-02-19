import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json();

  const backendUrl = `${process.env.BASE_API_URL}/reservation/checkout`;

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  return NextResponse.json(data, { status: response.status });
}
