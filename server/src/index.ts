import 'dotenv/config';
import express from 'express';
import * as http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@bloodbanc/shared';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { registerSocketHandlers } from './socket/index.js';
import { sweepRequests } from './services/requestService.js';

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);

// ---- Dynamic CORS configuration (supports localhost, 127.0.0.1, LAN IPs, and custom hostnames) ----
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true,
};

// ---- Socket.io server ----
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: (origin, callback) => {
      callback(null, true);
    },
    credentials: true,
  },
});
app.set('io', io);
registerSocketHandlers(io);

// ---- Security hardening ----
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));

// Global rate limiter (mitigate brute-force/DoS)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});
app.use('/api', globalLimiter);

// Stricter limiter for auth endpoints (credential stuffing protection)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts' },
});
app.use('/api/auth', authLimiter);

// Request logging (basic)
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// ---- Routes ----
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// 404 + error handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Background sweeper (escalation + expiry) ----
const SWEEP_INTERVAL_MS = 15_000;
setInterval(() => {
  sweepRequests(io).catch((err) => console.error('[sweeper] error:', err));
}, SWEEP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[server] BloodBanc API + Socket.io listening on :${PORT}`);
});