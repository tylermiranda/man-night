import type { Env, UserRow } from './types';

function decodeAccessJwtClaims(jwt: string | null): { email?: string; common_name?: string } | null {
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad)) as { email?: string; common_name?: string };
  } catch {
    return null;
  }
}

export async function resolveAuthUser(request: Request, env: Env): Promise<{
  user: UserRow | null;
  via: 'access_email' | 'service_token' | 'local_dev' | 'unauthenticated';
  email: string | null;
}> {
  const jwtClaims = decodeAccessJwtClaims(request.headers.get('Cf-Access-Jwt-Assertion'));
  const cfEmail = request.headers.get('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase()
    ?? (typeof jwtClaims?.email === 'string' ? jwtClaims.email.toLowerCase() : null);

  if (cfEmail) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1')
      .bind(cfEmail)
      .first<UserRow>();
    return { user: user ?? null, via: 'access_email', email: cfEmail };
  }

  // Cloudflare Access validates service tokens at edge and forwards common_name in Cf-Access-Jwt-Assertion
  const serviceId = request.headers.get('Cf-Access-Client-Id')?.trim()
    || (typeof jwtClaims?.common_name === 'string' && jwtClaims.common_name.endsWith('.access')
      ? jwtClaims.common_name
      : null);

  if (serviceId) {
    const fallbackSlug = env.DEV_DEFAULT_USER || 'tyler';
    const user = await env.DB.prepare('SELECT * FROM users WHERE slug = ? LIMIT 1')
      .bind(fallbackSlug)
      .first<UserRow>();
    return { user: user ?? null, via: 'service_token', email: user?.email ?? null };
  }

  // Allow local development override only on localhost/127.0.0.1 or test harness requests
  const url = new URL(request.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === 'test.local';
  if (isLocal) {
    const devSlug = request.headers.get('X-Dev-User')?.trim().toLowerCase() || env.DEV_DEFAULT_USER || 'tyler';
    const user = await env.DB.prepare('SELECT * FROM users WHERE slug = ? OR LOWER(email) = ? LIMIT 1')
      .bind(devSlug, devSlug)
      .first<UserRow>();
    return { user: user ?? null, via: 'local_dev', email: user?.email ?? null };
  }

  return { user: null, via: 'unauthenticated', email: null };
}
