import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;

  const backendUrl = `${process.env.BASE_API_URL}/reservation/asset/${assetId}`;

  const response = await fetch(backendUrl);
  const data = await response.json();

  return Response.json(data);
}

