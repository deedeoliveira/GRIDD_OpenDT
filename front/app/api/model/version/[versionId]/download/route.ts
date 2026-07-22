import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  if (!/^\d+$/.test(versionId)) return NextResponse.json({ error: "Valid version ID is required" }, { status: 400 });
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  try {
    const response = await fetch(`${process.env.BASE_API_URL}/model/versions/${versionId}/download`, {
      headers,
      cache: "no-store",
    });
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        ...(response.headers.get("content-disposition") ? { "content-disposition": response.headers.get("content-disposition")! } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "The model file service is unavailable." }, { status: 503 });
  }
}
