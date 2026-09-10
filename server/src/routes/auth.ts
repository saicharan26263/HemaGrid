import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, type TokenPayload } from '../auth/jwt.js';
import { authRequired, type AuthedRequest } from '../auth/middleware.js';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });
const registerSchema = z.object({
  facilityId: z.string().uuid(),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'HOSPITAL', 'BLOOD_CENTER']),
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid login payload', code: 'VALIDATION' });
    return;
  }
  const { email, password } = parsed.data;
  const r = await query(
    `SELECT u.*, f.name AS facility_name FROM users u JOIN facilities f ON f.id = u.facility_id WHERE u.email=$1`,
    [email],
  );
  if (!r.rows[0]) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const user = r.rows[0];
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const payload: TokenPayload = {
    sub: user.id,
    facilityId: user.facility_id,
    role: user.role,
    email: user.email,
    name: user.name,
  };
  res.json({
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
    user: { id: user.id, facilityId: user.facility_id, name: user.name, email: user.email, role: user.role },
  });
});

authRouter.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid register payload', code: 'VALIDATION' });
    return;
  }
  const { facilityId, name, email, password, role } = parsed.data;
  const exists = await query(`SELECT 1 FROM users WHERE email=$1`, [email]);
  if ((exists.rowCount ?? 0) > 0) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  const hash = await hashPassword(password);
  const r = await query(
    `INSERT INTO users (facility_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [facilityId, name, email, hash, role],
  );
  res.status(201).json({ id: r.rows[0]!.id });
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) {
    res.status(400).json({ error: 'Missing refreshToken' });
    return;
  }
  try {
    const payload = verifyRefreshToken(refreshToken);
    const fresh: TokenPayload = {
      sub: payload.sub,
      facilityId: payload.facilityId,
      role: payload.role,
      email: payload.email,
      name: payload.name,
    };
    res.json({ accessToken: signAccessToken(fresh), refreshToken: signRefreshToken(fresh) });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

authRouter.get('/me', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const r = await query(
    `SELECT u.name, u.email, u.role, u.facility_id, f.name AS facility_name, f.type, f.state, f.city
     FROM users u JOIN facilities f ON f.id = u.facility_id WHERE u.id=$1`,
    [user.sub],
  );
  if (!r.rows[0]) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ...user, ...r.rows[0] });
});