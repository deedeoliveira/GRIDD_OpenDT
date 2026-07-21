import { NextResponse } from "next/server";

export async function GET(_req: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const response = await fetch(`${process.env.BASE_API_URL}/semantic-evidence/${path.map(encodeURIComponent).join("/")}`);
  const contentType = response.headers.get("content-type") ?? "application/json";
  return new NextResponse(await response.arrayBuffer(), { status: response.status, headers: { "Content-Type": contentType } });
}
