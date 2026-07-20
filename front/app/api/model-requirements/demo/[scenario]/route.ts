import { NextResponse } from "next/server";

export async function POST(_request: Request, context: { params: Promise<{ scenario: string }> }) {
  const { scenario } = await context.params;
  try {
    const response = await fetch(
      `${process.env.BASE_API_URL}/model-requirements/demo/${encodeURIComponent(scenario)}`,
      { method: "POST", cache: "no-store" },
    );
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { ok: false, code: "ids_demo_unavailable", message: "IDS demonstrator is unavailable." },
      { status: 503 },
    );
  }
}
