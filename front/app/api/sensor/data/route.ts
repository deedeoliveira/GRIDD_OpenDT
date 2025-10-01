import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, { params } : { params: Promise<{ modelId: string, binSize: string, start: string, end: string }> }) {
    const modelId = request.nextUrl.searchParams.get("modelId");

    if (!modelId)
        return NextResponse.json({ error: "Model ID is required" }, { status: 400 });

    const binSize = request.nextUrl.searchParams.get("binSize");
    const start = request.nextUrl.searchParams.get("start");
    const end = request.nextUrl.searchParams.get("end");

    const res = await fetch(`${process.env.BASE_API_URL}/sensor/data/?modelId=${modelId}${binSize ? `&binSize=${binSize}` : ''}${start ? `&start=${start}` : ''}${end ? `&end=${end}` : ''}`);

    if (!res.ok)
        return NextResponse.json({ error: "Failed to fetch sensor data" }, { status: res.status });

    return NextResponse.json((await res.json()).data, { status: 200 });
}