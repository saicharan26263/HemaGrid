-- BloodBanc schema (PostgreSQL + PostGIS)
-- Designed with security-first: no patient PII, parameterized access only.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Facilities (hospitals + blood centers)
CREATE TABLE IF NOT EXISTS facilities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('HOSPITAL','BLOOD_CENTER')),
  state       TEXT NOT NULL,          -- US state abbreviation (e.g. 'NY')
  city        TEXT NOT NULL,
  address     TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom        GEOGRAPHY(POINT, 4326)
);
CREATE INDEX IF NOT EXISTS idx_facilities_geom ON facilities USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_facilities_state ON facilities (state);

-- Users (accounts tied to a facility)
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('ADMIN','HOSPITAL','BLOOD_CENTER')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inventory (per facility, per blood type). Pull-model: private to owner.
CREATE TABLE IF NOT EXISTS inventory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  blood_type   TEXT NOT NULL CHECK (blood_type IN ('O-','O+','A-','A+','B-','B+','AB-','AB+')),
  units        INTEGER NOT NULL CHECK (units >= 0),
  expires_at   DATE NOT NULL,
  flagged      BOOLEAN NOT NULL DEFAULT FALSE,
  comment      TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (facility_id, blood_type)
);
CREATE INDEX IF NOT EXISTS idx_inventory_facility ON inventory (facility_id);

-- Blood requests
CREATE TABLE IF NOT EXISTS requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  blood_type   TEXT NOT NULL CHECK (blood_type IN ('O-','O+','A-','A+','B-','B+','AB-','AB+')),
  units        INTEGER NOT NULL CHECK (units > 0),
  urgency      TEXT NOT NULL CHECK (urgency IN ('CRITICAL','URGENT','STANDARD')),
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MATCHED','IN_TRANSIT','FULFILLED','CANCELLED','EXPIRED')),
  tier         INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests (requester_id);

-- Matches (a specific provider offered against a specific request)
CREATE TABLE IF NOT EXISTS matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_id      UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  matched_blood_type TEXT NOT NULL,
  units            INTEGER NOT NULL,
  distance_m       DOUBLE PRECISION NOT NULL,
  score            DOUBLE PRECISION NOT NULL,
  compatibility    TEXT NOT NULL CHECK (compatibility IN ('EXACT','COMPATIBLE','UNIVERSAL_DONOR')),
  response         TEXT NOT NULL DEFAULT 'PENDING' CHECK (response IN ('PENDING','ACCEPT','REJECT')),
  reason           TEXT,
  responded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_matches_request ON matches (request_id);
CREATE INDEX IF NOT EXISTS idx_matches_provider ON matches (provider_id);

-- Escalation / audit trail
CREATE TABLE IF NOT EXISTS escalation_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  tier         INTEGER NOT NULL,
  provider_id  UUID,
  action       TEXT NOT NULL CHECK (action IN ('MATCHED','ESCALATED','NO_RESPONSE','REJECTED','ACCEPTED','TIMEOUT')),
  detail       TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_esc_request ON escalation_events (request_id);

-- Audit log (accountability: who did what, when)
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  facility_id UUID,
  action      TEXT NOT NULL,
  meta        JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_facility ON audit_log (facility_id);