import { NextResponse } from 'next/server';
import { normalizeManagerProxyResponse } from '@/lib/managerProxyResponse.mts';

function jsonError(status: number, code: string, message: string) {
  return JSON.stringify({ ok: false, status, code, message, details: null });
}

export async function relay(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  const query = new URL(request.url).search;
  const requestText = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const headers = new Headers({ Accept: 'application/json' });
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  if (requestText) headers.set('content-type', request.headers.get('content-type') ?? 'application/json');

  try {
    const response = await fetch(`${process.env.BASE_API_URL}/manager/${path}${query}`, {
      method: request.method,
      cache: 'no-store',
      headers,
      body: requestText || undefined,
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const normalized = normalizeManagerProxyResponse(response.status, contentType, body);
    const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const name of ['x-correlation-id', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new NextResponse(normalized.body, { status: normalized.status, headers: responseHeaders });
  } catch {
    return new NextResponse(jsonError(502, 'manager_proxy_unavailable', 'The reservation service is unavailable.'), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

export const GET = relay;
export const POST = relay;
