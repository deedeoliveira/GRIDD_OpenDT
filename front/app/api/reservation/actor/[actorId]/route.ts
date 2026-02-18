import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: { actorId: string } }
) {
  const { actorId } = params;

  const backendUrl = `${process.env.BASE_API_URL}/reservation/actor/${actorId}`;

  try {
    const res = await fetch(backendUrl);
    const data = await res.json();

    return NextResponse.json(data, { status: res.status });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }
}
