import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ actorId: string }> }
) {
  const { actorId } = await params;

  const backendUrl =
    `${process.env.BASE_API_URL}/reservation/actor/${actorId}`;

  try {
    const response = await fetch(backendUrl);
    const data = await response.json();

    return NextResponse.json(data, { status: response.status });

  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }
}


