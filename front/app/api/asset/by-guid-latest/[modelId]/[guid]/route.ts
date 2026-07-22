import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ modelId: string; guid: string }> }
) {
  const { modelId, guid } = await params;

  const backendUrl =
    `${process.env.BASE_API_URL}/asset/by-guid-latest/${modelId}/${guid}`;

  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(backendUrl, { headers, cache: "no-store" });
  const data = await response.json();

  return NextResponse.json(data, { status: response.status });
}
