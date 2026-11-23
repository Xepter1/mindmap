// Optional single-password login. Off unless IDEENRAUM_PASSWORD is set.
// Sessions are signed cookies; changing the password logs every device out.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const COOKIE = 'ideenraum_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const b64 = buf => Buffer.from(buf).toString('base64url');

export async function createAuth({ password, dataDir, secureCookies = false }) {
  if (!password) return { enabled: false, check: () => true };

  const secretFile = path.join(dataDir, '.session-secret');
  let secret = process.env.IDEENRAUM_SECRET || '';
  if (!secret) {
    try { secret = (await fs.readFile(secretFile, 'utf8')).trim(); } catch { /* first start */ }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(secretFile, secret, { mode: 0o600 });
    }
  }
  const key = crypto.createHmac('sha256', secret).update(password).digest();
  const sign = payload => b64(crypto.createHmac('sha256', key).update(payload).digest());
  const attempts = new Map();

  function readCookie(req) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return decodeURIComponent(v.join('='));
    }
    return '';
  }
  function cookieHeader(value, maxAge, req) {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https';
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  return {
    enabled: true,
    check(req) {
      const [v, exp, sig] = readCookie(req).split('.');
      if (v !== 'v1' || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(`v1.${exp}`)), got = Buffer.from(sig);
      return want.length === got.length && crypto.timingSafeEqual(want, got);
    },
    login(req, res, given) {
      const ip = req.socket.remoteAddress || '?', now = Date.now();
      const a = attempts.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
      if (now > a.reset) { a.n = 0; a.reset = now + 10 * 60 * 1000; }
      if (a.n >= 10) return { ok: false, status: 429, error: 'Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.' };
      if (!crypto.timingSafeEqual(sha(given || ''), sha(password))) {
        a.n += 1; attempts.set(ip, a);
        return { ok: false, status: 401, error: 'Das Passwort stimmt nicht.' };
      }
      attempts.delete(ip);
      const exp = Math.floor(now / 1000) + MAX_AGE;
      res.setHeader('Set-Cookie', cookieHeader(`v1.${exp}.${sign(`v1.${exp}`)}`, MAX_AGE, req));
      return { ok: true };
    },
    logout(req, res) { res.setHeader('Set-Cookie', cookieHeader('', 0, req)); },
  };
}
