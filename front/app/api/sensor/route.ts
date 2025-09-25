import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
    const res = await fetch('http://localhost:3001/api/sensor/');

    return NextResponse.json((await res.json()).data, { status: 200 });
}