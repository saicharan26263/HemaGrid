# BloodBanc — National Hospital-to-Hospital Blood Mutual-Aid Network

## Vision
A real-time B2B platform connecting hospitals and blood centers across all US states.
When a hospital is critically short on a blood type, it raises a request; the platform
finds the nearest hospital/center with matching stock and coordinates a fast (
<15 min optimal, <1 hr hard cap) physical transfer.

## Core product primitives
1. **Private inventory (pull-model)** — Each hospital owns its own inventory record.
   Blood is described by type/units/expiry/flags, NEVER patient identity.
2. **Smart matcher** — exact ABO/Rh -> compatible types -> universal donor (O-) fallback.
3. **Geo-routing + tiers** — nearest match first; cascade outward on miss/reject; 1 hr cap.
4. **Obligation engine** — receiving hospital gets a timer; auto-escalate on no-response;
   call-to-confirm popup; accountability/penalty trail for non-compliant staff.
5. **Transport tracking** — ambulance/courier leg handled by hospitals, tracked in-app.

## Architecture
- **Monorepo (npm workspaces):** client (React+Vite+TS+Tailwind v4) / server (Node+Express+Socket.io) / shared (types).
- **DB:** PostgreSQL 18 + PostGIS 3.6 (geography column for hospitals).
- **Real-time:** Socket.io for live inventory updates, request push, escalation.
- **Auth:** JWT (access + refresh), role-based (ADMIN / HOSPITAL / BLOOD_CENTER), bcrypt password hashing.

## Data model
- hospitals: id, name, state, role, address, geom(Point,4326), contact, verified
- inventory: hospital_id, blood_type, units, expiry, flagged
- requests: id, requester_id, blood_type, units, urgency, status, tier, created_at, deadline
- matches: request_id, provider_id, blood_type, units, distance_m, response (PENDING/ACCEPT/REJECT), responded_at
- escalation_events: request_id, tier, provider_id, action, at
- users: id, hospital_id, email, password_hash, role, name
- audit_log: for accountability (who rejected, who ignored)

## Blood compatibility (smart matcher)
- Donor -> Recipient matrix. Exact first, then compatible (O- universal donor, AB+ universal recipient, etc).
- Scoring: exact=0, compatible=1, universal donor=2 (lower is better), then distance, then expiry.

## Escalation tiers
- Tier 0: nearest hospitals within X km (confidence 15 min)
- Tier 1: expand radius
- Tier 2: all compatible statewide
- Timer per match: N minutes to respond; else auto-escalate to next provider + log penalty.
- "Call to confirm" popup surfaces hospital phone number.

## Security requirements (explicit from user)
- Helmet headers, CORS allowlist, rate limiting, input validation (zod), parameterized SQL,
  JWT expiry/rotation, RBAC, audit logging, no patient PII by design, secrets via env.
- PostgreSQL parameterized queries only (no SQL injection).
- Socket.io auth middleware; rooms scoped per hospital.