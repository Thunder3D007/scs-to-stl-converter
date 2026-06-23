import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // ── Security Headers ──
  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');
  // Prevent MIME-type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Force HTTPS
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  );
  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Disable unnecessary browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  // Content Security Policy — tight but allows HOOPS WASM/eval
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // HOOPS bundle requires eval and inline scripts
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
      // Tailwind + inline styles
      "style-src 'self' 'unsafe-inline'",
      // Images from data URIs and blobs (HOOPS textures)
      "img-src 'self' data: blob:",
      // Fonts from self
      "font-src 'self'",
      // HOOPS loads WASM and creates worker blobs
      "worker-src 'self' blob:",
      // HOOPS creates object URLs for SCS files
      "connect-src 'self' blob: data:",
      // No external frames allowed
      "frame-src 'none'",
      // No plugins
      "object-src 'none'",
      // Base URI restriction
      "base-uri 'self'",
      // Form submissions only to self
      "form-action 'self'",
    ].join('; '),
  );

  return response;
}

export const config = {
  // Apply security headers to all routes
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
