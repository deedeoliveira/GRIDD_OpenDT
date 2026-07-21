import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const headers = new Headers();
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${process.env.BASE_API_URL}/reservations/mine`, { headers, cache: 'no-store' });
  return new NextResponse(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });
}
