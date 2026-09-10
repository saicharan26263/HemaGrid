import { query, withTransaction } from '../db/pool.js';
import { findCandidates } from '../matching/matcher.js';
import {
  dispatchTier,
  escalateToNextTier,
  rejectOtherPendingMatches,
  expireRequestIfOverdue,
  TIER_RADII_M,
} from '../matching/escalation.js';
import {
  classifyCompatibility,
  compatibilityScore,
  donorPreferenceOrder,
  type BloodGroup,
  type BloodRequest,
  type RequestDetail,
  type Urgency,
  type Match,
  type MatchResponse,
  type MatchCandidate,
} from '@bloodbanc/shared';

export interface CreateRequestInput {
  requesterId: string;
  bloodType: BloodGroup;
  units: number;
  urgency: Urgency;
  notes?: string;
  targetFacilityId?: string;
}

export async function getFacilityLatLng(facilityId: string): Promise<{ lat: number; lng: number }> {
  const r = await query(
    `SELECT ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng FROM facilities WHERE id=$1`,
    [facilityId],
  );
  if (!r.rows[0]) throw new Error('Facility not found');
  return { lat: Number(r.rows[0].lat), lng: Number(r.rows[0].lng) };
}

// ---- camelCase mappers (DB returns snake_case, API/live types are camelCase) ----

type RequestRow = Record<string, unknown> & {
  id: string; requester_id: string; blood_type: BloodGroup; units: number;
  urgency: Urgency; status: string; tier: number; notes: string | null;
  created_at: string; deadline_at: string;
};

function mapRequestRow(r: RequestRow): BloodRequest {
  return {
    id: r.id,
    requesterId: r.requester_id,
    bloodType: r.blood_type,
    units: r.units,
    urgency: r.urgency,
    status: r.status as BloodRequest['status'],
    tier: r.tier,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    deadlineAt: r.deadline_at,
  };
}

type MatchRow = Record<string, unknown> & {
  id: string; request_id: string; provider_id: string; matched_blood_type: BloodGroup;
  units: number; distance_m: number; score: number; compatibility: string;
  response: string; reason: string | null; responded_at: string | null; created_at: string;
};

function mapMatchRow(m: MatchRow): Match {
  return {
    id: m.id,
    requestId: m.request_id,
    providerId: m.provider_id,
    matchedBloodType: m.matched_blood_type,
    units: m.units,
    distanceM: m.distance_m,
    score: m.score,
    compatibility: m.compatibility as Match['compatibility'],
    response: m.response as Match['response'],
    reason: m.reason ?? undefined,
    respondedAt: m.responded_at ?? undefined,
    createdAt: m.created_at,
  };
}

/**
 * Create a blood request and immediately dispatch Tier 0 matches.
 */
export async function createRequest(input: CreateRequestInput): Promise<BloodRequest> {
  const deadlineAt = new Date(Date.now() + Number(process.env.REQUEST_HARD_CAP_SEC || 3600) * 1000);
  const requester = await getFacilityLatLng(input.requesterId);

  if (input.targetFacilityId && input.targetFacilityId !== input.requesterId) {
    // 1. Direct targeted request to the specified hospital (bypasses radius filters)
    const distRes = await query(
      `SELECT f.id, f.name,
              ST_Distance(f.geom, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m
       FROM facilities f WHERE f.id = $3`,
      [requester.lng, requester.lat, input.targetFacilityId],
    );

    if (!distRes.rows[0]) {
      throw new Error('Target facility not found');
    }

    const target = distRes.rows[0];
    const distM = Number(target.distance_m) || 0;

    // Check target facility inventory for compatible blood types
    const acceptable = donorPreferenceOrder(input.bloodType);
    const invRes = await query(
      `SELECT blood_type, units, flagged FROM inventory
       WHERE facility_id = $1 AND blood_type = ANY($2::text[]) AND expires_at >= CURRENT_DATE
       ORDER BY (blood_type = $3) DESC, units DESC`,
      [input.targetFacilityId, acceptable, input.bloodType],
    );

    // Check if target facility has sufficient stock of compatible blood
    const candidateRow = invRes.rows.find((r) => Number(r.units) >= input.units);

    if (!candidateRow) {
      const maxAvailable = invRes.rows.reduce((max, r) => Math.max(max, Number(r.units) || 0), 0);
      if (maxAvailable === 0) {
        throw new Error(
          `Target hospital "${target.name}" currently has 0 units of compatible blood available for ${input.bloodType}.`
        );
      } else {
        throw new Error(
          `Target hospital "${target.name}" has insufficient stock: only ${maxAvailable} unit(s) of compatible blood available (${input.units} requested). Please adjust requested units or select another facility.`
        );
      }
    }

    const res = await query(
      `INSERT INTO requests (requester_id, blood_type, units, urgency, status, tier, notes, deadline_at)
       VALUES ($1,$2,$3,$4,'OPEN',0,$5,$6) RETURNING *`,
      [input.requesterId, input.bloodType, input.units, input.urgency, input.notes ?? null, deadlineAt.toISOString()],
    );
    const req = mapRequestRow(res.rows[0] as RequestRow);

    const matchedBloodType = candidateRow.blood_type as BloodGroup;
    const unitsOffered = input.units; // Exactly what was requested, not provider total stock!
    const compat = classifyCompatibility(matchedBloodType, input.bloodType) || 'EXACT';
    const cScore = compatibilityScore(compat);
    const score = cScore * 1_000_000 + distM;

    await query(
      `INSERT INTO matches (request_id, provider_id, matched_blood_type, units, distance_m, score, compatibility, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')`,
      [req.id, input.targetFacilityId, matchedBloodType, unitsOffered, distM, score, compat],
    );

    await query(
      `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
       VALUES ($1,0,$2,'MATCHED',$3)`,
      [req.id, input.targetFacilityId, `Direct request targeted to ${target.name} (${matchedBloodType}, ${Math.round(distM / 1000)}km)`],
    );

    return req;
  } else {
    // Standard Tier 0 automated geo-dispatch
    const res = await query(
      `INSERT INTO requests (requester_id, blood_type, units, urgency, status, tier, notes, deadline_at)
       VALUES ($1,$2,$3,$4,'OPEN',0,$5,$6) RETURNING *`,
      [input.requesterId, input.bloodType, input.units, input.urgency, input.notes ?? null, deadlineAt.toISOString()],
    );
    const req = mapRequestRow(res.rows[0] as RequestRow);

    const candidates = await findCandidates({
      requesterFacilityId: input.requesterId,
      requesterLat: requester.lat,
      requesterLng: requester.lng,
      requestedType: input.bloodType,
      units: input.units,
      radiusM: TIER_RADII_M[0]!,
    });
    await dispatchTier(req.id, input.requesterId, 0, candidates, input.units);
    return req;
  }
}

/**
 * A provider responds to a match (ACCEPT or REJECT).
 */
export async function respondToMatch(input: {
  requestId: string;
  providerId: string;
  response: MatchResponse;
  reason?: string;
}): Promise<{
  accepted: boolean;
  requestStatus: string;
  updatedInventory?: any;
  reroutedProviderId?: string;
  reroutedProviderName?: string;
  reroutedDistanceM?: number;
}> {
  return withTransaction(async (client) => {
    const match = await client.query(
      `SELECT * FROM matches
       WHERE request_id=$1 AND provider_id=$2 AND response='PENDING'
       ORDER BY created_at ASC LIMIT 1`,
      [input.requestId, input.providerId],
    );
    if (!match.rows[0]) throw new Error('No pending match found for this provider');

    const matchId = match.rows[0].id as string;
    await client.query(
      `UPDATE matches SET response=$1, reason=$2, responded_at=now() WHERE id=$3`,
      [input.response, input.reason ?? null, matchId],
    );

    await client.query(
      `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
       VALUES ($1, (SELECT tier FROM requests WHERE id=$1), $2, $3, $4)`,
      [input.requestId, input.providerId, input.response === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', input.reason ?? null],
    );

    let accepted = false;
    let status = 'OPEN';
    let updatedInventory: any = null;
    let reroutedProviderId: string | undefined;
    let reroutedProviderName: string | undefined;
    let reroutedDistanceM: number | undefined;

    if (input.response === 'ACCEPT') {
      accepted = true;
      status = 'MATCHED';
      await client.query(`UPDATE requests SET status='MATCHED' WHERE id=$1`, [input.requestId]);
      // Reject other pending offers
      await client.query(
        `UPDATE matches SET response='REJECT', reason='Another provider accepted', responded_at=now()
         WHERE request_id=$1 AND response='PENDING' AND id<>$2`,
        [input.requestId, matchId],
      );
      // Decrement inventory of the accepting provider
      const invRes = await client.query(
        `UPDATE inventory SET units = GREATEST(units - (SELECT units FROM requests WHERE id=$1), 0), updated_at=now()
         WHERE facility_id=$2 AND blood_type=$3
         RETURNING id, facility_id AS "facilityId", blood_type AS "bloodType",
                   units, expires_at AS "expiresAt", flagged, comment, updated_at AS "updatedAt"`,
        [input.requestId, input.providerId, match.rows[0].matched_blood_type],
      );
      updatedInventory = invRes.rows[0];
    } else {
      // Provider rejected.
      // Immediately analyze and find next nearest hospital with blood to replace the declining facility!
      const reqRes = await client.query(`SELECT * FROM requests WHERE id=$1`, [input.requestId]);
      if (reqRes.rows[0] && reqRes.rows[0].status === 'OPEN') {
        const reqRow = reqRes.rows[0] as RequestRow;
        const requester = await getFacilityLatLng(reqRow.requester_id);

        // Exclude all hospitals that have already been matched or rejected for this request
        const excludedRes = await client.query(
          `SELECT provider_id::text FROM matches WHERE request_id=$1`,
          [input.requestId],
        );
        const excludeFacilityIds = excludedRes.rows.map((r: any) => r.provider_id);

        // Find candidate hospitals with compatible blood and sufficient units, prioritizing closest distance
        let candidates: MatchCandidate[] = [];
        let targetTier = reqRow.tier;

        for (let t = reqRow.tier; t < TIER_RADII_M.length; t++) {
          candidates = await findCandidates({
            requesterFacilityId: reqRow.requester_id,
            requesterLat: requester.lat,
            requesterLng: requester.lng,
            requestedType: reqRow.blood_type,
            units: reqRow.units,
            radiusM: TIER_RADII_M[t]!,
            excludeFacilityIds,
            limit: 1,
          });
          if (candidates.length > 0) {
            targetTier = t;
            break;
          }
        }

        // If no candidates in current/higher tiers, search lower tiers if tier was escalated
        if (candidates.length === 0 && reqRow.tier > 0) {
          for (let t = 0; t < reqRow.tier; t++) {
            candidates = await findCandidates({
              requesterFacilityId: reqRow.requester_id,
              requesterLat: requester.lat,
              requesterLng: requester.lng,
              requestedType: reqRow.blood_type,
              units: reqRow.units,
              radiusM: TIER_RADII_M[t]!,
              excludeFacilityIds,
              limit: 1,
            });
            if (candidates.length > 0) {
              targetTier = t;
              break;
            }
          }
        }

        if (candidates.length > 0) {
          const nextCandidate = candidates[0]!;
          if (targetTier !== reqRow.tier) {
            await client.query(`UPDATE requests SET tier=$1 WHERE id=$2`, [targetTier, reqRow.id]);
          }
          const unitsToMatch = Math.min(reqRow.units, nextCandidate.inventory.units);
          const distM = nextCandidate.distanceM;
          const score = nextCandidate.score;
          const compat = nextCandidate.compatibility;

          await client.query(
            `INSERT INTO matches (request_id, provider_id, matched_blood_type, units, distance_m, score, compatibility, response)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING')`,
            [reqRow.id, nextCandidate.facility.id, nextCandidate.inventory.bloodType, unitsToMatch, distM, score, compat],
          );

          const distKmStr = (distM / 1000).toFixed(1);
          await client.query(
            `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
             VALUES ($1,$2,$3,'MATCHED',$4)`,
            [
              reqRow.id,
              targetTier,
              nextCandidate.facility.id,
              `Auto-rerouted: Offered to next nearest hospital ${nextCandidate.facility.name} (${distKmStr}km away, ${unitsToMatch}u of ${nextCandidate.inventory.bloodType})`,
            ],
          );

          reroutedProviderId = nextCandidate.facility.id;
          reroutedProviderName = nextCandidate.facility.name;
          reroutedDistanceM = distM;
        } else {
          await client.query(
            `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
             VALUES ($1,$2,NULL,'ESCALATED',$3)`,
            [reqRow.id, reqRow.tier, 'All nearby facilities with compatible blood exhausted or already declined'],
          );
        }
      }
    }

    return {
      accepted,
      requestStatus: status,
      updatedInventory,
      reroutedProviderId,
      reroutedProviderName,
      reroutedDistanceM,
    };
  });
}

/**
 * Fetch full request detail for UI.
 */
export async function getRequestDetail(requestId: string): Promise<RequestDetail> {
  const req = await query(
    `SELECT r.*, f.name AS requester_name, f.city AS requester_city, f.state AS requester_state,
            f.phone AS requester_phone, f.address AS requester_address
     FROM requests r JOIN facilities f ON f.id = r.requester_id WHERE r.id=$1`,
    [requestId],
  );
  if (!req.rows[0]) throw new Error('Request not found');
  const matches = await query(
    `SELECT m.*, f.name AS provider_name, f.city AS provider_city, f.state AS provider_state,
            f.phone AS provider_phone, f.address AS provider_address
     FROM matches m
     JOIN facilities f ON f.id = m.provider_id
     WHERE m.request_id=$1
     ORDER BY (m.response = 'ACCEPT') DESC, (m.response = 'PENDING') DESC, m.score ASC, m.distance_m ASC, m.created_at DESC`,
    [requestId],
  );
  const escalations = await query(
    `SELECT * FROM escalation_events WHERE request_id=$1 ORDER BY at ASC`,
    [requestId],
  );
  const base = req.rows[0] as RequestRow & {
    requester_name: string;
    requester_city?: string;
    requester_state?: string;
    requester_phone?: string;
    requester_address?: string;
  };
  const topMatch = (matches.rows[0] || {}) as Record<string, unknown>;
  return {
    ...mapRequestRow(base),
    requesterName: base.requester_name,
    requesterCity: base.requester_city,
    requesterState: base.requester_state,
    requesterPhone: base.requester_phone,
    requesterAddress: base.requester_address,
    providerId: (topMatch.provider_id as string) || undefined,
    providerName: (topMatch.provider_name as string) || undefined,
    providerCity: (topMatch.provider_city as string) || undefined,
    providerState: (topMatch.provider_state as string) || undefined,
    providerPhone: (topMatch.provider_phone as string) || undefined,
    providerAddress: (topMatch.provider_address as string) || undefined,
    distanceM: topMatch.distance_m != null ? Number(topMatch.distance_m) : undefined,
    providerMatchStatus: (topMatch.response as string) || undefined,
    matches: (matches.rows as MatchRow[]).map(mapMatchRow),
    escalations: escalations.rows as unknown as RequestDetail['escalations'],
  };
}

/**
 * Cancel a request (only requester or admin).
 */
export async function cancelRequest(requestId: string, requesterId: string): Promise<void> {
  const existing = await query(`SELECT * FROM requests WHERE id=$1`, [requestId]);
  if (!existing.rows[0]) throw new Error('Request not found');
  const req = existing.rows[0] as RequestRow;

  if (req.status === 'CANCELLED') {
    return; // Already cancelled; idempotent
  }
  if (req.status === 'FULFILLED') {
    throw new Error('Cannot cancel a fulfilled request');
  }
  if (req.status === 'EXPIRED') {
    throw new Error('Request has already expired');
  }

  // Allow requesting facility or any ADMIN to cancel
  if (requesterId && req.requester_id !== requesterId) {
    const adminCheck = await query(`SELECT role FROM users WHERE facility_id=$1 AND role='ADMIN'`, [requesterId]);
    if (adminCheck.rows.length === 0) {
      throw new Error('Only the requesting facility or an administrator can cancel this request');
    }
  }

  await query(`UPDATE requests SET status='CANCELLED' WHERE id=$1`, [requestId]);
  await rejectOtherPendingMatches(requestId, null, 'Request cancelled by requester');
  await query(
    `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
     VALUES ($1, $2, NULL, 'REJECTED', 'Request cancelled by requester')`,
    [requestId, req.tier],
  );
}

/**
 * Advance transport status (IN_TRANSIT -> FULFILLED).
 */
export async function advanceTransport(requestId: string, status: 'IN_TRANSIT' | 'FULFILLED'): Promise<void> {
  await query(`UPDATE requests SET status=$1 WHERE id=$2`, [status, requestId]);
}

/**
 * Central sweeper: escalate no-response tiers and expire overdue requests.
 * Called on an interval by the server. Durable (DB-backed), unlike setTimeout.
 */
export async function sweepRequests(io?: any): Promise<void> {
  // Expire overdue
  const overdue = await query(
    `UPDATE requests SET status='EXPIRED'
     WHERE status IN ('OPEN','MATCHED','IN_TRANSIT') AND deadline_at <= now() RETURNING id, requester_id`,
  );
  for (const r of overdue.rows) {
    await query(
      `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
       VALUES ($1, 99, NULL, 'TIMEOUT', 'Hard cap exceeded')`,
      [r.id],
    );
    if (io) {
      getRequestDetail(r.id as string).then((detail) => {
        io.to(`facility:${detail.requesterId}`).emit('request:status', detail);
        for (const m of detail.matches) {
          io.to(`facility:${m.providerId}`).emit('request:status', detail);
        }
      }).catch(() => {});
    }
  }

  // Escalate tiers where pending matches have been sitting > timeout
  const timeoutSec = Number(process.env.MATCH_RESPONSE_TIMEOUT_SEC || 120);
  const stalled = await query(
    `SELECT r.id, r.tier FROM requests r
     JOIN matches m ON m.request_id = r.id
     WHERE r.status='OPEN' AND m.response='PENDING'
       AND m.created_at <= now() - ($1 || ' seconds')::interval
     GROUP BY r.id, r.tier`,
    [timeoutSec],
  );

  for (const s of stalled.rows) {
    const id = s.id as string;
    const currentTier = Number(s.tier);

    // 1. Fetch the timed-out pending matches
    const timedOut = await query(
      `SELECT m.id, m.provider_id, f.name AS provider_name
       FROM matches m
       JOIN facilities f ON f.id = m.provider_id
       WHERE m.request_id = $1 AND m.response = 'PENDING'
         AND m.created_at <= now() - ($2 || ' seconds')::interval`,
      [id, timeoutSec],
    );

    // 2. Mark them as REJECT so they are never re-swept, and log provider accountability event
    for (const m of timedOut.rows) {
      await query(
        `UPDATE matches SET response='REJECT', reason='Response SLA timed out (<15m SLA)', responded_at=now()
         WHERE id=$1`,
        [m.id],
      );
      await query(
        `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
         VALUES ($1, $2, $3, 'NO_RESPONSE', $4)`,
        [id, Math.min(currentTier, TIER_RADII_M.length - 1), m.provider_id, `Hospital ${m.provider_name} failed to respond within SLA window (<15m)`],
      );
    }

    // 3. If other matches are still pending/accepted, let them proceed
    const active = await query(
      `SELECT id FROM matches WHERE request_id=$1 AND response IN ('PENDING', 'ACCEPT')`,
      [id],
    );
    if (active.rows.length > 0) continue;

    // 4. Try to escalate / reroute to next tier
    const nextTier = Math.min(currentTier + 1, TIER_RADII_M.length - 1);
    const req = await query(`SELECT * FROM requests WHERE id=$1 AND status='OPEN'`, [id]);
    if (!req.rows[0]) continue;
    const rr = mapRequestRow(req.rows[0] as RequestRow);
    const { lat, lng } = await getFacilityLatLng(rr.requesterId);

    let candidates: MatchCandidate[] = [];
    let targetTier = nextTier;
    for (let t = nextTier; t < TIER_RADII_M.length; t++) {
      candidates = await findCandidates({
        requesterFacilityId: rr.requesterId,
        requesterLat: lat,
        requesterLng: lng,
        requestedType: rr.bloodType,
        units: rr.units,
        radiusM: TIER_RADII_M[t]!,
        excludeFacilityIds: (await query(
          `SELECT provider_id::text FROM matches WHERE request_id=$1`,
          [id],
        )).rows.map((x) => x.provider_id),
      });
      if (candidates.length > 0) {
        targetTier = t;
        break;
      }
    }

    if (candidates.length > 0) {
      await query(`UPDATE requests SET tier=$1 WHERE id=$2`, [targetTier, id]);
      const created = await dispatchTier(id, rr.requesterId, targetTier, candidates, rr.units);
      if (io && created.length > 0) {
        getRequestDetail(id).then((detail) => {
          io.to(`facility:${rr.requesterId}`).emit('request:status', detail);
          for (const c of created) {
            io.to(`facility:${c.providerId}`).emit('request:incoming', rr);
            io.to(`facility:${c.providerId}`).emit('request:status', detail);
          }
        }).catch(() => {});
      }
    } else {
      await query(`UPDATE requests SET tier=$1 WHERE id=$2`, [Math.min(currentTier + 1, TIER_RADII_M.length - 1), id]);
      await query(
        `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
         VALUES ($1, $2, NULL, 'ESCALATED', 'All nearby facilities with compatible blood exhausted or timed out')`,
        [id, Math.min(currentTier + 1, TIER_RADII_M.length - 1)],
      );
    }
  }
}

export { expireRequestIfOverdue };