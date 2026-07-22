import { NextResponse } from "next/server";

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${process.env.BASE_API_URL}/model-intake/${path.map(encodeURIComponent).join("/")}`;
  try {
    const method = request.method;
    const requestHeaders = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) requestHeaders.set("cookie", cookie);
    const init: RequestInit = { method, cache: "no-store", headers: requestHeaders };
    if (method !== "GET" && method !== "HEAD") init.body = await request.formData();
    const response = await fetch(target, init);
    const contentType = response.headers.get("content-type") ?? "application/json";
    const disposition = response.headers.get("content-disposition");
    const body = await response.arrayBuffer();
    const headers = new Headers({ "Content-Type": contentType });
    if (disposition) headers.set("Content-Disposition", disposition);
    return new NextResponse(body, { status: response.status, headers });
  } catch {
    return NextResponse.json({ ok: false, message: "The model intake backend is unavailable." }, { status: 503 });
  }
}

export const GET = proxy;
export const POST = proxy;
