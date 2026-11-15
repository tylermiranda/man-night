import type { Env, PushPayload } from './types';

function b64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function importVapidPrivateKey(publicKeyB64: string, privateKeyB64: string): Promise<CryptoKey> {
  const pub = b64UrlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('Invalid VAPID public key');
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64Url(pub.slice(1, 33)),
    y: bytesToB64Url(pub.slice(33, 65)),
    d: privateKeyB64,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function createVapidAuthHeader(
  endpoint: string,
  subject: string,
  publicKeyB64: string,
  privateKeyB64: string,
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = bytesToB64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64Url(enc.encode(JSON.stringify({ aud: origin, exp: now + 43200, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const key = await importVapidPrivateKey(publicKeyB64, privateKeyB64);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned)),
  );
  const jwt = `${unsigned}.${bytesToB64Url(sig)}`;
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypts a Web Push payload according to RFC 8291 (aes128gcm).
 */
export async function encryptWebPushPayload(
  plaintext: string,
  userPublicKeyB64: string,
  userAuthB64: string,
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const uaPublicBytes = b64UrlToBytes(userPublicKeyB64);
  const authSecret = b64UrlToBytes(userAuthB64);

  const asKeyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublicBytes = new Uint8Array((await crypto.subtle.exportKey('raw', asKeyPair.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKeyPair.privateKey, 256),
  );

  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublicBytes, asPublicBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const paddedPlaintext = concatBytes(enc.encode(plaintext), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, paddedPlaintext),
  );

  const header = new Uint8Array(21 + asPublicBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublicBytes.length;
  header.set(asPublicBytes, 21);

  return concatBytes(header, ciphertext);
}

export async function sendWebPushToSubscribers(
  env: Env,
  payload: PushPayload,
  prefColumn: 'notify_night_vote' | 'notify_place' | 'notify_reminder' | 'all' = 'all',
  targetSlugs?: string[],
): Promise<{ sent: number; failed: number; removed: number }> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return { sent: 0, failed: 0, removed: 0 };
  }

  let sql = `
    SELECT ps.id, ps.user_slug, ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN users u ON u.slug = ps.user_slug
  `;
  const conds: string[] = [];
  if (prefColumn !== 'all') {
    conds.push(`u.${prefColumn} = 1`);
  }
  if (targetSlugs && targetSlugs.length > 0) {
    conds.push(`ps.user_slug IN (${targetSlugs.map(() => '?').join(',')})`);
  }
  if (conds.length > 0) sql += ` WHERE ${conds.join(' AND ')}`;

  const stmt = env.DB.prepare(sql);
  const rows = (targetSlugs && targetSlugs.length > 0 ? await stmt.bind(...targetSlugs).all() : await stmt.all())
    .results as Array<{ id: number; user_slug: string; endpoint: string; p256dh: string; auth: string }>;

  if (rows.length === 0) return { sent: 0, failed: 0, removed: 0 };

  const subject = env.VAPID_SUBJECT || 'mailto:tyler.miranda@gmail.com';
  const jsonBody = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  let removed = 0;

  const notifType = payload.tag || (prefColumn === 'all' ? 'general' : prefColumn.replace(/^notify_/, ''));

  await Promise.all(
    rows.map(async (sub) => {
      try {
        const authHeader = await createVapidAuthHeader(
          sub.endpoint,
          subject,
          env.VAPID_PUBLIC_KEY!,
          env.VAPID_PRIVATE_KEY!,
        );
        const body = await encryptWebPushPayload(jsonBody, sub.p256dh, sub.auth);
        const resp = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: 'high',
          },
          body,
        });
        if (resp.status === 201 || resp.status === 200 || resp.status === 202) {
          sent++;
          await env.DB.prepare("UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE id = ?")
            .bind(sub.id)
            .run();
          await env.DB.prepare(
            "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'sent')"
          )
            .bind(sub.user_slug, notifType, sub.endpoint)
            .run()
            .catch(() => {});
        } else if (resp.status === 404 || resp.status === 410) {
          removed++;
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
          await env.DB.prepare(
            "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'removed')"
          )
            .bind(sub.user_slug, notifType, sub.endpoint)
            .run()
            .catch(() => {});
        } else {
          failed++;
          await env.DB.prepare(
            "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'failed')"
          )
            .bind(sub.user_slug, notifType, sub.endpoint)
            .run()
            .catch(() => {});
        }
      } catch {
        failed++;
        await env.DB.prepare(
          "INSERT OR IGNORE INTO notification_logs (user_slug, notification_type, delivery_endpoint, status) VALUES (?, ?, ?, 'failed')"
        )
          .bind(sub.user_slug, notifType, sub.endpoint)
          .run()
          .catch(() => {});
      }
    }),
  );

  return { sent, failed, removed };
}
