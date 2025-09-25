import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, { params } : { params: Promise<{ modelId: string }> }) {
    const modelId = (await params).modelId;

    if (!modelId)
        return NextResponse.json({ error: "Model ID is required" }, { status: 400 });

    const res = await fetch(`${process.env.BASE_API_URL}/model/${modelId}`);

    return NextResponse.json((await res.json()).data, { status: 200 });
}