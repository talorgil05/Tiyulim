import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const N = 16384, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, n, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n) });
  return crypto.timingSafeEqual(key, expected);
}

// A dummy hash so login time doesn't reveal whether a username exists.
let dummyHash;
export async function dummyVerify(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Very small in-memory limiter for login attempts. */
export class AttemptLimiter {
  constructor({ max = 8, windowMs = 10 * 60 * 1000 } = {}) {
    this.max = max; this.windowMs = windowMs; this.map = new Map();
  }
  blocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (Date.now() - e.first > this.windowMs) { this.map.delete(key); return false; }
    return e.count >= this.max;
  }
  fail(key) {
    const e = this.map.get(key);
    if (!e || Date.now() - e.first > this.windowMs) this.map.set(key, { first: Date.now(), count: 1 });
    else e.count++;
  }
  reset(key) { this.map.delete(key); }
}
