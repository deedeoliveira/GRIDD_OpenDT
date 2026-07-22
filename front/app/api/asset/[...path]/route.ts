import { NextResponse } from "next/server";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/asset/${path.map(encodeURIComponent).join("/")}`, { cache: "no-store", headers });
    const contentType = response.headers.get("content-type") ?? "application/json";
    return new NextResponse(await response.arrayBuffer(), { status: response.status, headers: { "Content-Type": contentType } });
  } catch {
    return NextResponse.json({ ok: false, message: "The asset backend is unavailable." }, { status: 503 });
  }
}
