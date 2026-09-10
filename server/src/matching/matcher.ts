import { classifyCompatibility, compatibilityScore, donorPreferenceOrder } from '@bloodbanc/shared';
import type { BloodGroup, MatchCandidate } from '@bloodbanc/shared';
import { query } from '../db/pool.js';

interface CandidateRow {
  facility_id: string;
  name: string;
  type: 'HOSPITAL' | 'BLOOD_CENTER';
  state: string;
  city: string;
  address: string;
  phone: string;
  email: string;
  verified: boolean;
  created_at: string;
  distance_m: number;
  blood_type: BloodGroup;
  units: number;
  expires_at: string;
  flagged: boolean;
  comment: string | null;
  updated_at: string;
}

/**
 * Find matching candidates (facilities with compatible blood) within a radius,
 * ordered by: compatibility score, then distance.
 * Excludes the requester itself and facilities with zero usable units.
 */
export async function findCandidates(params: {
  requesterFacilityId: string;
  requesterLat: number;
  requesterLng: number;
  requestedType: BloodGroup;
  units: number;
  radiusM: number;
  excludeFacilityIds?: string[];
  limit?: number;
}): Promise<MatchCandidate[]> {
  const {
    requesterFacilityId,
    requesterLat,
    requesterLng,
    requestedType,
    units,
    radiusM,
    excludeFacilityIds = [],
    limit = 20,
  } = params;

  // Build acceptable donor types (exact first, then compatible, O- last)
  const acceptable = donorPreferenceOrder(requestedType);
  const exclude = [requesterFacilityId, ...excludeFacilityIds];

  // Fixed positional params: 1=lng 2=lat 3=units 4=exclude 5=radius 6=requestedType 7=limit
  // Acceptable-type placeholders start at $8 to avoid collision.
  const placeholders = acceptable.map((_, i) => `$${i + 8}`).join(',');
  const sql = `
    SELECT
      f.id AS facility_id, f.name, f.type, f.state, f.city, f.address,
      f.phone, f.email, f.verified, f.created_at,
      ST_Distance(f.geom, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance_m,
      inv.blood_type, inv.units, inv.expires_at, inv.flagged, inv.comment, inv.updated_at
    FROM inventory inv
    JOIN facilities f ON f.id = inv.facility_id
    WHERE inv.units >= $3
      AND inv.facility_id != ALL($4::uuid[])
      AND (f.address IS NULL OR LOWER(TRIM(f.address)) != (SELECT LOWER(TRIM(address)) FROM facilities WHERE id = $4[1]))
      AND inv.blood_type IN (${placeholders})
      AND ST_DWithin(f.geom, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $5)
      AND inv.expires_at >= CURRENT_DATE
    ORDER BY inv.blood_type <> $6, ST_Distance(f.geom, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)
    LIMIT $7
  `;

  const result = await query<CandidateRow>(sql, [
    requesterLng,
    requesterLat,
    units,
    exclude,
    radiusM,
    requestedType,
    limit,
    ...acceptable,
  ]);

  const candidates: MatchCandidate[] = [];
  for (const row of result.rows) {
    const compat = classifyCompatibility(row.blood_type, requestedType);
    if (!compat) continue;
    const cScore = compatibilityScore(compat);
    // score: compatibility weight dominates, distance is tie-breaker in meters
    const score = cScore * 1_000_000 + row.distance_m;
    candidates.push({
      facility: {
        id: row.facility_id,
        name: row.name,
        type: row.type,
        state: row.state,
        city: row.city,
        address: row.address,
        lat: 0, // filled by caller if needed (not in this query)
        lng: 0,
        phone: row.phone,
        email: row.email,
        verified: row.verified,
        createdAt: row.created_at,
      },
      inventory: {
        id: '',
        facilityId: row.facility_id,
        bloodType: row.blood_type,
        units: row.units,
        expiresAt: row.expires_at,
        flagged: row.flagged,
        comment: row.comment ?? undefined,
        updatedAt: row.updated_at,
      },
      distanceM: row.distance_m,
      compatibility: compat,
      score,
    });
  }

  // secondary sort by score ascending, then distance
  candidates.sort((a, b) => a.score - b.score || a.distanceM - b.distanceM);
  return candidates.slice(0, limit);
}