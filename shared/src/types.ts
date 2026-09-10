// ============================================================
// BloodBanc shared domain types
// Used by both client and server. No runtime deps.
// ============================================================

// ---- Blood types ----
export type BloodGroup =
  | 'O-'
  | 'O+'
  | 'A-'
  | 'A+'
  | 'B-'
  | 'B+'
  | 'AB-'
  | 'AB+';

export const BLOOD_GROUPS: BloodGroup[] = [
  'O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+',
];

// ---- Roles ----
export type UserRole = 'ADMIN' | 'HOSPITAL' | 'BLOOD_CENTER';

export type FacilityType = 'HOSPITAL' | 'BLOOD_CENTER';

// ---- Facility / user ----
export interface FacilityStockItem {
  bloodType: BloodGroup;
  units: number;
}

export interface Facility {
  id: string;
  name: string;
  type: FacilityType;
  state: string; // US state abbreviation
  city: string;
  address: string;
  lat: number;
  lng: number;
  phone: string;
  email: string;
  verified: boolean;
  createdAt?: string;
  inventory?: FacilityStockItem[];
}

export interface PublicUser {
  id: string;
  facilityId: string;
  name: string;
  email: string;
  role: UserRole;
}

// ---- Inventory ----
export interface InventoryItem {
  id: string;
  facilityId: string;
  bloodType: BloodGroup;
  units: number;
  expiresAt: string; // ISO date
  flagged: boolean; // e.g. near expiry, storage issue
  comment?: string;
  updatedAt: string;
}

// ---- Requests & matching ----
export type RequestStatus =
  | 'OPEN' // actively seeking matches
  | 'MATCHED' // a provider accepted
  | 'IN_TRANSIT' // blood physically moving
  | 'FULFILLED' // delivered
  | 'CANCELLED'
  | 'EXPIRED'; // hit 1hr hard cap, no fulfillment

export type Urgency = 'CRITICAL' | 'URGENT' | 'STANDARD';

export interface BloodRequest {
  id: string;
  requesterId: string; // facility id
  bloodType: BloodGroup;
  units: number;
  urgency: Urgency;
  status: RequestStatus;
  tier: number; // current escalation tier
  createdAt: string;
  deadlineAt: string; // 1hr hard cap
  notes?: string;
}

export type MatchResponse = 'PENDING' | 'ACCEPT' | 'REJECT';

export interface Match {
  id: string;
  requestId: string;
  providerId: string;
  matchedBloodType: BloodGroup; // actual type offered (may differ from request if compatible)
  units: number;
  distanceM: number;
  score: number; // lower = better
  compatibility: 'EXACT' | 'COMPATIBLE' | 'UNIVERSAL_DONOR';
  response: MatchResponse;
  reason?: string;
  respondedAt?: string;
  createdAt: string;
  providerName?: string;
  providerCity?: string;
  providerState?: string;
  providerPhone?: string;
  providerAddress?: string;
}

export interface EscalationEvent {
  id: string;
  requestId: string;
  tier: number;
  providerId: string | null;
  action: 'MATCHED' | 'ESCALATED' | 'NO_RESPONSE' | 'REJECTED' | 'ACCEPTED' | 'TIMEOUT';
  detail: string;
  at: string;
}

// ---- Request detail (aggregate view for UI) ----
export interface RequestDetail extends BloodRequest {
  requesterName: string;
  requesterCity?: string;
  requesterState?: string;
  requesterPhone?: string;
  requesterAddress?: string;
  providerId?: string;
  providerName?: string;
  providerCity?: string;
  providerState?: string;
  providerPhone?: string;
  providerAddress?: string;
  distanceM?: number;
  providerMatchStatus?: string;
  matches: Match[];
  escalations: EscalationEvent[];
}

// ---- Geo / matching ----
export interface MatchCandidate {
  facility: Facility;
  inventory: InventoryItem;
  distanceM: number;
  compatibility: 'EXACT' | 'COMPATIBLE' | 'UNIVERSAL_DONOR';
  score: number;
}

// ---- Auth ----
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface RegisterPayload {
  facilityId: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

// ---- Socket.io event contracts ----
export interface ServerToClientEvents {
  'inventory:updated': (facilityId: string, item: InventoryItem) => void;
  'request:incoming': (req: BloodRequest) => void;
  'request:matched': (reqId: string, match: Match) => void;
  'request:escalated': (reqId: string, event: EscalationEvent) => void;
  'request:status': (req: RequestDetail) => void;
  'match:response': (reqId: string, match: Match) => void;
  'error:validation': (errors: unknown) => void;
  'error:general': (message: string) => void;
}

export interface ClientToServerEvents {
  'inventory:upsert': (item: { bloodType: BloodGroup; units: number; expiresAt: string; flagged: boolean; comment?: string }) => void;
  'request:create': (payload: { bloodType: BloodGroup; units: number; urgency: Urgency; notes?: string; targetFacilityId?: string }) => void;
  'match:respond': (payload: { requestId: string; response: 'ACCEPT' | 'REJECT'; reason?: string }) => void;
  'request:cancel': (payload: { requestId: string }) => void;
  'transport:status': (payload: { requestId: string; status: 'IN_TRANSIT' | 'FULFILLED' }) => void;
}

// ---- REST response envelope ----
export interface ApiError {
  error: string;
  code?: string;
}