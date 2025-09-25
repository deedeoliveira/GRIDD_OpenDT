import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
    const res = await fetch(`${process.env.BASE_API_URL}/model`);

    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch models' }, { status: res.status });

    return NextResponse.json((await res.json()).data, { status: 200 });
}