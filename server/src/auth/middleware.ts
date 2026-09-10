import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type TokenPayload } from './jwt.js';
import { query } from '../db/pool.js';

// Extend Express Request to carry the authenticated user.
export interface AuthedRequest extends Request {
  user?: TokenPayload;
}

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    (req as AuthedRequest).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function roleAllowed(...roles: ('ADMIN' | 'HOSPITAL' | 'BLOOD_CENTER')[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthedRequest).user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: 'Insufficient role for this action' });
      return;
    }
    next();
  };
}

// Verify a facility exists and is not banned (lightweight)
export async function facilityActive(facilityId: string): Promise<boolean> {
  const r = await query('SELECT 1 FROM facilities WHERE id = $1', [facilityId]);
  return (r.rowCount ?? 0) > 0;
}