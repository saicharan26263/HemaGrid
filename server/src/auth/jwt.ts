import 'dotenv/config';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwtPkg from 'jsonwebtoken';
import type { UserRole } from '@bloodbanc/shared';

// jsonwebtoken is CJS; normalize to named functions for stable API.
const { sign, verify } = jwtPkg as {
  sign: typeof jwtPkg['sign'];
  verify: typeof jwtPkg['verify'];
};

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';

export interface TokenPayload {
  sub: string; // user id
  facilityId: string;
  role: UserRole;
  email: string;
  name: string;
}

// ---- Password hashing (Node crypto scrypt — zero external deps) ----
// Format: scrypt$N$r$p$salt$hash  (N,r,p are base64'd to be URL-safe-free printable)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(plain, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

export function signAccessToken(payload: TokenPayload): string {
  return sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL as jwtPkg.SignOptions['expiresIn'] });
}

export function signRefreshToken(payload: TokenPayload): string {
  return sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL as jwtPkg.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): TokenPayload {
  return verify(token, ACCESS_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return verify(token, REFRESH_SECRET) as TokenPayload;
}