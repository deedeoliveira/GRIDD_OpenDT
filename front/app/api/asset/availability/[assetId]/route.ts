import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  console.log("PROXY availability called");
  console.log("assetId:", assetId);
  console.log("start:", start);
  console.log("end:", end);
  console.log("BASE_API_URL:", process.env.BASE_API_URL);

  const backendUrl =
    `${process.env.BASE_API_URL}/asset/availability/${assetId}` +
    `?start=${encodeURIComponent(start!)}&end=${encodeURIComponent(end!)}`;

  console.log("backendUrl:", backendUrl);

  try {
    const res = await fetch(backendUrl);

    console.log("backend status:", res.status);

    const data = await res.json();

    return NextResponse.json(data, { status: res.status });
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }
}
