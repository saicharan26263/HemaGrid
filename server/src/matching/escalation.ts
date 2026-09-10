import { query, withTransaction } from '../db/pool.js';
import type { MatchCandidate } from '@bloodbanc/shared';

// Escalation tier configuration (meters).
// Tier 0 = nearest (15 min target), Tier 1 = wider, Tier 2 = statewide, Tier 3 = regional, Tier 4 = nationwide (covers coast-to-coast).
export const TIER_RADII_M = [10_000, 50_000, 250_000, 1_000_000, 5_000_000];

const RESPONSE_TIMEOUT_SEC = Number(process.env.MATCH_RESPONSE_TIMEOUT_SEC || 120);
const HARD_CAP_SEC = Number(process.env.REQUEST_HARD_CAP_SEC || 3600);

export interface EmitFn {
  (event: string, ...args: unknown[]): void;
}

/**
 * Dispatch matches for a request at the given tier.
 * Creates PENDING match rows for the top N candidates and returns them.
 */
export async function dispatchTier(
  requestId: string,
  requesterFacilityId: string,
  tier: number,
  candidates: MatchCandidate[],
  requestedUnits?: number,
): Promise<{ matchId: string; providerId: string }[]> {
  const created: { matchId: string; providerId: string }[] = [];
  // Dispatch to the single best nearest candidate in this tier.
  // If they reject or time out, our failover pipeline automatically advances to the next nearest candidate.
  const top = candidates.slice(0, 1);
  for (const c of top) {
    const unitsToMatch = requestedUnits ? Math.min(requestedUnits, c.inventory.units) : c.inventory.units;
    const r = await query(
      `INSERT INTO matches (request_id, provider_id, matched_blood_type, units, distance_m, score, compatibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [requestId, c.facility.id, c.inventory.bloodType, unitsToMatch, c.distanceM, c.score, c.compatibility],
    );
    created.push({ matchId: r.rows[0]!.id as string, providerId: c.facility.id });
    await query(
      `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
       VALUES ($1,$2,$3,'MATCHED',$4)`,
      [requestId, tier, c.facility.id, `Offered ${c.inventory.bloodType} (${unitsToMatch}u) at ${Math.round(c.distanceM / 1000)}km`],
    );
  }
  return created;
}

/**
 * Record a NO_RESPONSE / escalation event when a tier times out.
 */
export async function escalateToNextTier(requestId: string, fromTier: number, reason: string): Promise<number> {
  const nextTier = fromTier + 1;
  await query(
    `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
     VALUES ($1,$2,NULL,'ESCALATED',$3)`,
    [requestId, nextTier, reason],
  );
  await query(`UPDATE requests SET tier = $1 WHERE id = $2`, [nextTier, requestId]);
  return nextTier;
}

/**
 * Mark all pending matches of a request as rejected (when a provider accepts, or request is cancelled).
 */
export async function rejectOtherPendingMatches(
  requestId: string,
  acceptedMatchId?: string | null,
  reason: string = 'Request closed',
): Promise<void> {
  if (acceptedMatchId) {
    await query(
      `UPDATE matches SET response='REJECT', reason=$2, responded_at=now()
       WHERE request_id=$1 AND response='PENDING' AND id<>$3`,
      [requestId, reason, acceptedMatchId],
    );
  } else {
    await query(
      `UPDATE matches SET response='REJECT', reason=$2, responded_at=now()
       WHERE request_id=$1 AND response='PENDING'`,
      [requestId, reason],
    );
  }
}

/**
 * Expire a request if it is still OPEN past the hard cap.
 */
export async function expireRequestIfOverdue(requestId: string): Promise<boolean> {
  const r = await query(
    `UPDATE requests SET status='EXPIRED' WHERE id=$1 AND status IN ('OPEN','MATCHED','IN_TRANSIT') AND deadline_at <= now()
     RETURNING id`,
    [requestId],
  );
  if ((r.rowCount ?? 0) > 0) {
    await query(
      `INSERT INTO escalation_events (request_id, tier, provider_id, action, detail)
       VALUES ($1, 99, NULL, 'TIMEOUT', 'Hard cap exceeded, request expired')`,
      [requestId],
    );
    return true;
  }
  return false;
}

/**
 * Schedule response-timeout and hard-cap timers for a freshly created request.
 * We use in-process setTimeout backed by periodic DB sweep for durability.
 * @returns timer handles (for tests / cleanup) — production relies on the sweeper.
 */
export function scheduleRequestTimers(
  requestId: string,
  emit: EmitFn,
): { responseTimer: NodeJS.Timeout; capTimer: NodeJS.Timeout } {
  const responseTimer = setTimeout(() => {
    // Timeout sweep is handled by the central sweeper; here we just emit a local signal.
    emit('request:escalated', requestId, { action: 'NO_RESPONSE', at: new Date().toISOString() });
  }, RESPONSE_TIMEOUT_SEC * 1000);

  const capTimer = setTimeout(() => {
    expireRequestIfOverdue(requestId).then((expired) => {
      if (expired) emit('request:status', requestId);
    });
  }, HARD_CAP_SEC * 1000);

  return { responseTimer, capTimer };
}

export { RESPONSE_TIMEOUT_SEC, HARD_CAP_SEC };