import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/model/student-contexts`, {
      headers,
      cache: "no-store",
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "The model backend is unavailable." }, { status: 503 });
  }
}
