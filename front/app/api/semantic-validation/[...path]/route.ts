import { NextResponse } from "next/server";

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${process.env.BASE_API_URL}/semantic-validation/${path.map(encodeURIComponent).join("/")}`;
  try {
    const response = await fetch(target, { cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "application/json";
    const disposition = response.headers.get("content-disposition");
    const body = await response.arrayBuffer();
    const headers = new Headers({ "Content-Type": contentType });
    if (disposition) headers.set("Content-Disposition", disposition);
    return new NextResponse(body, { status: response.status, headers });
  } catch {
    return NextResponse.json({ ok: false, message: "The semantic validation backend is unavailable." }, { status: 503 });
  }
}
