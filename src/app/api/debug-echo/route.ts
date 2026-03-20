import { NextRequest, NextResponse } from 'next/server';
import { isDebugAllowed } from '@/lib/debug/isDebugAllowed';

// DEV ONLY ECHO. DO NOT ENABLE IN PROD.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function buildResponse(req: NextRequest, buf: Uint8Array) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const rawUtf8 = decoder.decode(buf);
  const rawJsonEscaped = JSON.stringify(rawUtf8);
  const hexPreview = Array.from(buf.slice(0, 200))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  const charCodes = rawUtf8
    .slice(0, 160)
    .split('')
    .map((char) => char.codePointAt(0));

  return {
    method: req.method,
    url: req.url,
    contentType: req.headers.get('content-type'),
    contentLength: req.headers.get('content-length'),
    bufLen: buf.length,
    rawUtf8,
    rawJsonEscaped,
    hexPreview,
    charCodes,
  };
}

export async function POST(req: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const buf = new Uint8Array(await req.arrayBuffer());
  return NextResponse.json(buildResponse(req, buf));
}

export async function GET(req: NextRequest) {
  if (!isDebugAllowed()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(buildResponse(req, new Uint8Array()));
}
