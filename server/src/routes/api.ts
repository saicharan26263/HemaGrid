import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authRequired, type AuthedRequest } from '../auth/middleware.js';
import {
  getRequestDetail,
  sweepRequests,
  createRequest,
  cancelRequest,
  respondToMatch,
} from '../services/requestService.js';

const createReqSchema = z.object({
  bloodType: z.enum(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']),
  units: z.number().int().min(1).max(200),
  urgency: z.enum(['CRITICAL', 'URGENT', 'STANDARD']),
  notes: z.string().max(500).optional(),
  targetFacilityId: z.string().uuid().optional(),
});

export const apiRouter = Router();

// ---- Facilities ----
// List facilities (basic directory search)
apiRouter.get('/facilities', authRequired, async (req: Request, res: Response) => {
  const state = (req.query.state as string | undefined)?.toUpperCase();
  const type = req.query.type as string | undefined;
  const q = (req.query.q as string | undefined)?.trim();
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 8000), 10000);

  let sql = `
    SELECT f.id, f.name, f.type, f.state, f.city, f.address, f.phone, f.email, f.verified,
           ST_Y(f.geom::geometry) AS lat, ST_X(f.geom::geometry) AS lng,
           COALESCE(inv_agg.inventory, '[]'::json) AS inventory
    FROM facilities f
    LEFT JOIN (
      SELECT facility_id, json_agg(json_build_object('bloodType', blood_type, 'units', units)) AS inventory
      FROM inventory
      GROUP BY facility_id
    ) inv_agg ON inv_agg.facility_id = f.id
  `;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (state && state !== 'ALL') { params.push(state); conds.push(`f.state=$${params.length}`); }
  if (type && type !== 'ALL') { params.push(type); conds.push(`f.type=$${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(f.name ILIKE $${params.length} OR f.city ILIKE $${params.length} OR f.address ILIKE $${params.length})`);
  }
  if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
  params.push(limit);
  sql += ` ORDER BY f.state, f.city, f.name LIMIT $${params.length}`;
  const r = await query(sql, params);
  const formatted = r.rows.map((row: any) => ({
    ...row,
    lat: Number(row.lat),
    lng: Number(row.lng),
  }));
  res.json(formatted);
});

// ---- Inventory (own facility read & update) ----
apiRouter.get('/inventory', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const r = await query(
    `SELECT id, facility_id AS "facilityId", blood_type AS "bloodType",
            units, expires_at AS "expiresAt", flagged, comment,
            updated_at AS "updatedAt"
     FROM inventory WHERE facility_id=$1 ORDER BY blood_type`,
    [user.facilityId],
  );
  res.json({ items: r.rows });
});

const inventoryUpsertSchema = z.object({
  bloodType: z.enum(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']),
  units: z.number().int().min(0),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  flagged: z.boolean(),
  comment: z.string().optional(),
});

apiRouter.put('/inventory', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const parsed = inventoryUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  }
  const { bloodType, units, expiresAt, flagged, comment } = parsed.data;
  const r = await query(
    `INSERT INTO inventory (facility_id, blood_type, units, expires_at, flagged, comment, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (facility_id, blood_type) DO UPDATE
     SET units=$3, expires_at=$4, flagged=$5, comment=$6, updated_at=now()
     RETURNING id, facility_id AS "facilityId", blood_type AS "bloodType",
               units, expires_at AS "expiresAt", flagged, comment, updated_at AS "updatedAt"`,
    [user.facilityId, bloodType, units, expiresAt, flagged, comment ?? null],
  );
  const item = r.rows[0];
  const io = req.app.get('io');
  if (io) {
    io.to(`facility:${user.facilityId}`).emit('inventory:updated', user.facilityId, item);
  }
  res.json({ item });
});

// ---- Requests ----
apiRouter.get('/requests', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const r = await query(
    `SELECT r.id, r.requester_id AS "requesterId", r.blood_type AS "bloodType",
            r.units, r.urgency, r.status, r.tier, r.notes,
            r.created_at AS "createdAt", r.deadline_at AS "deadlineAt",
            req.name AS "requesterName",
            req.city AS "requesterCity",
            req.state AS "requesterState",
            req.phone AS "requesterPhone",
            req.address AS "requesterAddress",
            EXISTS(SELECT 1 FROM matches m WHERE m.request_id = r.id AND m.provider_id = $1 AND m.response = 'PENDING') AS "hasPendingMatch",
            (SELECT m.matched_blood_type FROM matches m WHERE m.request_id = r.id AND m.provider_id = $1 LIMIT 1) AS "matchedBloodType",
            (SELECT m.provider_id FROM matches m WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerId",
            (SELECT prov.name FROM matches m JOIN facilities prov ON prov.id = m.provider_id WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerName",
            (SELECT prov.city FROM matches m JOIN facilities prov ON prov.id = m.provider_id WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerCity",
            (SELECT prov.state FROM matches m JOIN facilities prov ON prov.id = m.provider_id WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerState",
            (SELECT prov.phone FROM matches m JOIN facilities prov ON prov.id = m.provider_id WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerPhone",
            (SELECT prov.address FROM matches m JOIN facilities prov ON prov.id = m.provider_id WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerAddress",
            (SELECT m.distance_m FROM matches m WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "distanceM",
            (SELECT m.response FROM matches m WHERE m.request_id = r.id ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC LIMIT 1) AS "providerMatchStatus"
     FROM requests r JOIN facilities req ON req.id = r.requester_id
     WHERE r.requester_id=$1
        OR r.id IN (SELECT request_id FROM matches WHERE provider_id=$1)
     ORDER BY r.created_at DESC LIMIT 200`,
    [user.facilityId],
  );
  res.json({ requests: r.rows });
});

apiRouter.get('/requests/:id', authRequired, async (req: Request, res: Response) => {
  try {
    const detail = await getRequestDetail(req.params.id!);
    res.json(detail);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Create new blood request via REST
apiRouter.post('/requests', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const parsed = createReqSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
  }

  try {
    const bloodReq = await createRequest({
      requesterId: user.facilityId,
      bloodType: parsed.data.bloodType,
      units: parsed.data.units,
      urgency: parsed.data.urgency,
      notes: parsed.data.notes,
      targetFacilityId: parsed.data.targetFacilityId,
    });

    const detail = await getRequestDetail(bloodReq.id);
    const io = req.app.get('io');
    if (io) {
      io.to(`facility:${user.facilityId}`).emit('request:status', detail);
      for (const m of detail.matches) {
        io.to(`facility:${m.providerId}`).emit('request:incoming', bloodReq);
        io.to(`facility:${m.providerId}`).emit('request:status', detail);
      }
    }

    res.status(201).json(detail);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Cancel a blood request via REST
apiRouter.post('/requests/:id/cancel', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  try {
    await cancelRequest(req.params.id!, user.facilityId);
    const detail = await getRequestDetail(req.params.id!);
    const io = req.app.get('io');
    if (io) {
      io.to(`facility:${detail.requesterId}`).emit('request:status', detail);
      for (const m of detail.matches) {
        io.to(`facility:${m.providerId}`).emit('request:status', detail);
      }
    }
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Respond to a match via REST
apiRouter.post('/requests/:id/respond', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const { response, reason } = req.body;
  try {
    const result = await respondToMatch({
      requestId: req.params.id!,
      providerId: user.facilityId,
      response,
      reason,
    });
    const detail = await getRequestDetail(req.params.id!);
    const io = req.app.get('io');
    if (io) {
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
        io.to(`facility:${detail.requesterId}`).emit(
          'request:matched',
          req.params.id!,
          detail.matches.find((m) => m.providerId === user.facilityId)!,
        );
      }
    }
    res.json({
      ok: true,
      detail,
      updatedInventory: result.updatedInventory,
      rerouted: !!result.reroutedProviderId,
      reroutedProviderName: result.reroutedProviderName,
      reroutedDistanceM: result.reroutedDistanceM,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---- Audit & Escalation Log ----
apiRouter.get('/audit-log', authRequired, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user!;
  const r = await query(
    `SELECT e.id, e.request_id AS "requestId", e.tier, e.provider_id AS "providerId",
            e.action, e.detail, e.at,
            f.name AS "providerName",
            r.blood_type AS "bloodType", r.units, r.urgency,
            req.name AS "requesterName"
     FROM escalation_events e
     LEFT JOIN facilities f ON f.id = e.provider_id
     LEFT JOIN requests r ON r.id = e.request_id
     LEFT JOIN facilities req ON req.id = r.requester_id
     ORDER BY e.at DESC LIMIT 100`,
  );
  res.json({ events: r.rows });
});

// ---- Admin: manual sweep trigger (dev / ops) ----
apiRouter.post('/admin/sweep', authRequired, async (req: Request, res: Response) => {
  await sweepRequests();
  res.json({ ok: true });
});