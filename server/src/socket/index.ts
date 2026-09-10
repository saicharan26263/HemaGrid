import type { Server, Socket } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, InventoryItem } from '@bloodbanc/shared';
import { verifyAccessToken, type TokenPayload } from '../auth/jwt.js';
import { query } from '../db/pool.js';
import { createRequest, respondToMatch, getRequestDetail, cancelRequest, advanceTransport } from '../services/requestService.js';
import { z } from 'zod';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

// Zod schemas for input validation
const upsertSchema = z.object({
  bloodType: z.enum(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']),
  units: z.number().int().min(0),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flagged: z.boolean(),
  comment: z.string().optional(),
});
const createReqSchema = z.object({
  bloodType: z.enum(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']),
  units: z.number().int().min(1).max(200),
  urgency: z.enum(['CRITICAL', 'URGENT', 'STANDARD']),
  notes: z.string().max(500).optional(),
  targetFacilityId: z.string().uuid().optional(),
});
const respondSchema = z.object({
  requestId: z.string().uuid(),
  response: z.enum(['ACCEPT', 'REJECT']),
  reason: z.string().max(300).optional(),
});
const cancelSchema = z.object({ requestId: z.string().uuid() });
const transportSchema = z.object({ requestId: z.string().uuid(), status: z.enum(['IN_TRANSIT', 'FULFILLED']) });

export function registerSocketHandlers(io: IOServer): void {
  // Auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = verifyAccessToken(token);
      (socket.data as { user?: TokenPayload }).user = payload;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: IOSocket) => {
    const user = (socket.data as { user?: TokenPayload }).user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    // Join a per-facility room for targeted pushes
    socket.join(`facility:${user.facilityId}`);
    socket.join(`user:${user.sub}`);

    // --- Inventory upsert (owner only) ---
    socket.on('inventory:upsert', async (payload) => {
      const parsed = upsertSchema.safeParse(payload);
      if (!parsed.success) return socket.emit('error:validation', parsed.error.flatten());
      const d = parsed.data;
      const res = await query(
        `INSERT INTO inventory (facility_id, blood_type, units, expires_at, flagged, comment, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (facility_id, blood_type) DO UPDATE SET units=$3, expires_at=$4, flagged=$5, comment=$6, updated_at=now()
         RETURNING id, facility_id AS "facilityId", blood_type AS "bloodType",
                   units, expires_at AS "expiresAt", flagged, comment, updated_at AS "updatedAt"`,
        [user.facilityId, d.bloodType, d.units, d.expiresAt, d.flagged, d.comment ?? null],
      );
      io.to(`facility:${user.facilityId}`).emit('inventory:updated', user.facilityId, res.rows[0] as InventoryItem);
    });

    // --- Create request ---
    socket.on('request:create', async (payload) => {
      const parsed = createReqSchema.safeParse(payload);
      if (!parsed.success) return socket.emit('error:validation', parsed.error.flatten());
      try {
        const req = await createRequest({
          requesterId: user.facilityId,
          bloodType: parsed.data.bloodType,
          units: parsed.data.units,
          urgency: parsed.data.urgency,
          notes: parsed.data.notes,
          targetFacilityId: parsed.data.targetFacilityId,
        });
        // Notify requester + all matched providers
        const detail = await getRequestDetail(req.id);
        io.to(`facility:${user.facilityId}`).emit('request:status', detail);
        for (const m of detail.matches) {
          io.to(`facility:${m.providerId}`).emit('request:incoming', req);
          io.to(`facility:${m.providerId}`).emit('request:status', detail);
        }
      } catch (err) {
        socket.emit('error:general', (err as Error).message);
      }
    });

    // --- Respond to match ---
    socket.on('match:respond', async (payload) => {
      const parsed = respondSchema.safeParse(payload);
      if (!parsed.success) return socket.emit('error:validation', parsed.error.flatten());
      try {
        const result = await respondToMatch({
          requestId: parsed.data.requestId,
          providerId: user.facilityId,
          response: parsed.data.response,
          reason: parsed.data.reason,
        });
        const detail = await getRequestDetail(parsed.data.requestId);
        // Broadcast updated status to requester and provider
        io.to(`facility:${detail.requesterId}`).emit('request:status', detail);
        io.to(`facility:${user.facilityId}`).emit('request:status', detail);
        if (result.reroutedProviderId) {
          io.to(`facility:${result.reroutedProviderId}`).emit('request:incoming', detail);
          io.to(`facility:${result.reroutedProviderId}`).emit('request:status', detail);
        }
        if (result.accepted) {
          if (result.updatedInventory) {
            io.to(`facility:${user.facilityId}`).emit('inventory:updated', user.facilityId, result.updatedInventory);
          }
          io.to(`facility:${detail.requesterId}`).emit('request:matched', parsed.data.requestId, detail.matches.find((m) => m.providerId === user.facilityId)!);
        }
      } catch (err) {
        socket.emit('error:general', (err as Error).message);
      }
    });

    // --- Cancel request ---
    socket.on('request:cancel', async (payload) => {
      const parsed = cancelSchema.safeParse(payload);
      if (!parsed.success) return socket.emit('error:validation', parsed.error.flatten());
      try {
        await cancelRequest(parsed.data.requestId, user.facilityId);
        const detail = await getRequestDetail(parsed.data.requestId);
        io.to(`facility:${detail.requesterId}`).emit('request:status', detail);
        for (const m of detail.matches) {
          io.to(`facility:${m.providerId}`).emit('request:status', detail);
        }
      } catch (err) {
        socket.emit('error:general', (err as Error).message);
      }
    });

    // --- Transport status ---
    socket.on('transport:status', async (payload) => {
      const parsed = transportSchema.safeParse(payload);
      if (!parsed.success) return socket.emit('error:validation', parsed.error.flatten());
      try {
        await advanceTransport(parsed.data.requestId, parsed.data.status);
        const detail = await getRequestDetail(parsed.data.requestId);
        io.to(`facility:${detail.requesterId}`).emit('request:status', detail);
        io.to(`facility:${user.facilityId}`).emit('request:status', detail);
      } catch (err) {
        socket.emit('error:general', (err as Error).message);
      }
    });

    socket.on('disconnect', () => {
      // no-op; rooms auto-cleaned
    });
  });
}