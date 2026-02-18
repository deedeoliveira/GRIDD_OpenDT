import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ actorId: string }> }
) {
  const { actorId } = await params;

  const backendUrl = `${process.env.BASE_API_URL}/reservation/actor/${actorId}`;

  const response = await fetch(backendUrl);
  const data = await response.json();

  return Response.json(data);
}

