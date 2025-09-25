import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, { params } : { params: Promise<{ modelId: string }> }) {
    const modelId = (await params).modelId;

    if (!modelId)
        return NextResponse.json({ error: "Model ID is required" }, { status: 400 });

    const res = await fetch(`${process.env.BASE_API_URL}/model/download/${modelId}`);

    const blob = await res.blob();

    const buffer = await blob.arrayBuffer();

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";

    return new NextResponse(buffer, { status: 200, headers: { "Content-Type": contentType } });
}