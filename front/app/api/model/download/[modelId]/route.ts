import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, { params } : { params: Promise<{ modelId: string }> }) {
    const modelId = (await params).modelId;

    if (!modelId)
        return NextResponse.json({ error: "Model ID is required" }, { status: 400 });

    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(`${process.env.BASE_API_URL}/model/download/${modelId}`, { headers, cache: "no-store" });

    const blob = await res.blob();

    const buffer = await blob.arrayBuffer();

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";

    return new NextResponse(buffer, { status: res.status, headers: { "Content-Type": contentType } });
}
