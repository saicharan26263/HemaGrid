import { useState, useEffect, useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import {
  BLOOD_GROUPS,
  type BloodGroup,
  type BloodRequest,
  type Facility,
  type InventoryItem,
} from '@bloodbanc/shared';
import { HospitalMap } from './components/HospitalMap';
import {
  BloodDropIcon,
  PulseIcon,
  AlertBeaconIcon,
  HospitalIcon,
  PhoneIcon,
  TruckIcon,
  ShieldCheckIcon,
  SendIcon,
  CheckCircleIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from './components/Icons';

const API = import.meta.env.VITE_API_URL || '/api';

interface AuditEvent {
  id: string;
  requestId: string;
  tier: number;
  providerId: string | null;
  action: 'MATCHED' | 'ESCALATED' | 'NO_RESPONSE' | 'REJECTED' | 'ACCEPTED' | 'TIMEOUT';
  detail: string;
  at: string;
  providerName?: string;
  bloodType?: BloodGroup;
  units?: number;
  urgency?: string;
  requesterName?: string;
}

interface RequestWithMeta extends BloodRequest {
  requesterName?: string;
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
  hasPendingMatch?: boolean;
  matchedBloodType?: BloodGroup;
  matchedUnits?: number;
  matches?: any[];
}

export default function App({ socket }: { socket: Socket }) {
  const [token, setToken] = useState<string>(() => localStorage.getItem('bb_token') || '');
  const [user, setUser] = useState<{
    name: string;
    role: string;
    facilityId: string;
    facilityName: string;
  } | null>(() => {
    const cached = localStorage.getItem('bb_user');
    return cached ? JSON.parse(cached) : null;
  });

  const [activeTab, setActiveTab] = useState<'dashboard' | 'map' | 'requests' | 'inventory' | 'facilities' | 'audit'>('dashboard');
  const [targetFacilityForRequest, setTargetFacilityForRequest] = useState<Facility | null>(null);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [requests, setRequests] = useState<RequestWithMeta[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);
  const [showCallModal, setShowCallModal] = useState<{ open: boolean; facility: Facility | null; req: RequestWithMeta | null }>({
    open: false,
    facility: null,
    req: null,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStateFilter, setSelectedStateFilter] = useState<string>('ALL');
  const [facilityPage, setFacilityPage] = useState(1);
  const [socketConnected, setSocketConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);

  const showNotification = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
    setNotice({ message: msg, type });
    setTimeout(() => setNotice(null), 5000);
  };

  // ---- Auth ----
  const login = async (email: string, pw: string) => {
    setLoading(true);
    try {
      const res = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Authentication failed');
      
      const u = {
        name: data.user.name,
        role: data.user.role,
        facilityId: data.user.facilityId,
        facilityName: data.user.name.replace(' Admin', ''),
      };
      
      setToken(data.accessToken);
      setUser(u);
      localStorage.setItem('bb_token', data.accessToken);
      localStorage.setItem('bb_user', JSON.stringify(u));
      showNotification('Welcome back, ' + u.name + '!', 'success');
    } catch (err: any) {
      showNotification(err.message, 'error');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('bb_token');
    localStorage.removeItem('bb_user');
    socket.disconnect();
  };

  // ---- Data fetching ----
  const loadData = async (tok: string) => {
    if (!tok) return;
    try {
      const [rInv, rFac, rReq, rAud] = await Promise.all([
        fetch(API + '/inventory', { headers: { Authorization: 'Bearer ' + tok } }),
        fetch(API + '/facilities', { headers: { Authorization: 'Bearer ' + tok } }),
        fetch(API + '/requests', { headers: { Authorization: 'Bearer ' + tok } }),
        fetch(API + '/audit-log', { headers: { Authorization: 'Bearer ' + tok } }),
      ]);

      if (rInv.ok) {
        const d = await rInv.json();
        setInventory(d.items || []);
      }
      if (rFac.ok) {
        const d = await rFac.json();
        setFacilities(d || []);
      }
      if (rReq.ok) {
        const d = await rReq.json();
        setRequests(d.requests || []);
      }
      if (rAud.ok) {
        const d = await rAud.json();
        setAuditEvents(d.events || []);
      }
    } catch (err) {
      console.error('Failed to load initial data', err);
    }
  };

  useEffect(() => {
    if (token && user) {
      loadData(token);
    }
  }, [token, user]);

  // ---- Real-time Socket ----
  useEffect(() => {
    if (!token || !user) return;
    socket.auth = { token };
    socket.connect();

    socket.on('connect', () => {
      setSocketConnected(true);
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('inventory:updated', (fid, rawItem: any) => {
      if (fid === user.facilityId) {
        const item: InventoryItem = {
          id: rawItem.id,
          facilityId: rawItem.facilityId || rawItem.facility_id,
          bloodType: rawItem.bloodType || rawItem.blood_type,
          units: Number(rawItem.units),
          expiresAt: rawItem.expiresAt || rawItem.expires_at,
          flagged: Boolean(rawItem.flagged),
          comment: rawItem.comment,
          updatedAt: rawItem.updatedAt || rawItem.updated_at,
        };
        setInventory((prev) => {
          const idx = prev.findIndex((i) => i.bloodType === item.bloodType);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = item;
            return next;
          }
          return [...prev, item];
        });
      }
    });

    socket.on('request:incoming', (req: any) => {
      showNotification('INCOMING REQUEST: ' + req.units + ' units of ' + req.bloodType + ' (' + req.urgency + ')', 'error');
      loadData(token);
    });

    socket.on('request:status', (req: any) => {
      setRequests((prev) => {
        const exists = prev.some((r) => r.id === req.id);
        if (exists) {
          return prev.map((r) => (r.id === req.id ? { ...r, ...req } : r));
        }
        return [req, ...prev];
      });
      loadData(token);
    });

    socket.on('request:matched', (_reqId, match) => {
      showNotification('MATCH CONFIRMED! Provider offered ' + match.matchedBloodType, 'success');
      loadData(token);
    });

    socket.on('request:escalated', (_reqId, event) => {
      showNotification('Auto-Escalation: Tier escalated due to ' + event.action, 'info');
      loadData(token);
    });

    socket.on('error:general', (msg: string) => {
      showNotification('Error: ' + msg, 'error');
    });

    return () => {
      socket.disconnect();
    };
  }, [token, user]);

  // ---- Actions ----
  const createRequest = async (
    bloodType: BloodGroup,
    units: number,
    urgency: 'CRITICAL' | 'URGENT' | 'STANDARD',
    notes?: string,
    targetFacilityId?: string,
  ) => {
    try {
      // Primary: REST API call (guaranteed delivery & single atomic creation)
      const res = await fetch(API + '/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          bloodType,
          units,
          urgency,
          notes: notes || undefined,
          targetFacilityId: targetFacilityId || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to create request' }));
        throw new Error(err.error || 'Failed to create request');
      }

      const createdDetail = await res.json();
      
      // Put the request in local state
      setRequests((prev) => [createdDetail, ...prev.filter((r) => r.id !== createdDetail.id)]);

      const target = targetFacilityId ? facilities.find((f) => f.id === targetFacilityId) : null;
      showNotification(
        target
          ? `Dispatched request for ${units} units of ${bloodType} directly to ${target.name} (${target.city}, ${target.state})`
          : `Dispatched request for ${units} units of ${bloodType} to regional mutual-aid network`,
        'success',
      );
      setTargetFacilityForRequest(null);
      loadData(token);
    } catch (err: any) {
      showNotification(err.message || 'Failed to create blood request', 'error');
    }
  };

  const respondToMatch = async (requestId: string, response: 'ACCEPT' | 'REJECT', reason?: string) => {
    try {
      const res = await fetch(`${API}/requests/${requestId}/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ response, reason }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to submit response' }));
        throw new Error(err.error || 'Failed to submit response');
      }

      const data = await res.json();
      if (data.detail) {
        setRequests((prev) => prev.map((r) => (r.id === requestId ? { ...r, ...data.detail } : r)));
      }
      if (data.updatedInventory) {
        setInventory((prev) => {
          const idx = prev.findIndex((i) => i.bloodType === data.updatedInventory.bloodType);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data.updatedInventory;
            return next;
          }
          return [...prev, data.updatedInventory];
        });
      }

      if (response === 'ACCEPT') {
        showNotification('Match accepted! Blood units dispatched & courier route authorized.', 'success');
      } else if (data.rerouted && data.reroutedProviderName) {
        showNotification(`Declined. Auto-routed to next closest hospital: ${data.reroutedProviderName} (${(data.reroutedDistanceM / 1000).toFixed(1)} km away)`, 'info');
      } else {
        showNotification('Response (REJECT) recorded.', 'info');
      }
      loadData(token);
    } catch (err: any) {
      showNotification(err.message || 'Failed to submit match response', 'error');
    }
  };

  const cancelRequest = async (requestId: string) => {
    try {
      setRequests((prev) => prev.map((r) => (r.id === requestId ? { ...r, status: 'CANCELLED' } : r)));

      const res = await fetch(`${API}/requests/${requestId}/cancel`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to cancel request' }));
        throw new Error(err.error || 'Failed to cancel request');
      }

      const updated = await res.json();
      setRequests((prev) => prev.map((r) => (r.id === requestId ? { ...r, ...updated } : r)));

      showNotification('Request cancelled.', 'info');
      loadData(token);
    } catch (err: any) {
      showNotification(err.message || 'Failed to cancel request', 'error');
    }
  };

  const advanceTransport = (requestId: string, status: 'IN_TRANSIT' | 'FULFILLED') => {
    socket.emit('transport:status', { requestId, status });
    showNotification('Transport status: ' + status, 'success');
  };

  const handleOpenCallModal = (req: RequestWithMeta) => {
    if (!user) return;
    const isRequester = req.requesterId === user.facilityId;
    let targetFac: Facility | undefined;

    if (isRequester) {
      // User is the requester: call the responding/matched provider!
      if (req.providerId) {
        targetFac = facilities.find((f) => f.id === req.providerId);
      }
      if (!targetFac && req.matches && req.matches.length > 0) {
        targetFac = facilities.find((f) => f.id === req.matches?.[0]?.providerId);
      }
      if (!targetFac && req.providerName) {
        targetFac = {
          id: req.providerId || 'provider',
          name: req.providerName,
          type: 'HOSPITAL',
          state: req.providerState || '',
          city: req.providerCity || '',
          address: req.providerAddress || '',
          phone: req.providerPhone || '(212) 555-0199',
          email: '',
          verified: true,
          lat: 0,
          lng: 0,
        };
      }
    } else {
      // User is the provider: call the requesting hospital!
      targetFac = facilities.find((f) => f.id === req.requesterId);
      if (!targetFac && req.requesterName) {
        targetFac = {
          id: req.requesterId,
          name: req.requesterName,
          type: 'HOSPITAL',
          state: req.requesterState || '',
          city: req.requesterCity || '',
          address: req.requesterAddress || '',
          phone: req.requesterPhone || '(212) 555-0199',
          email: '',
          verified: true,
          lat: 0,
          lng: 0,
        };
      }
    }

    if (targetFac) {
      setShowCallModal({ open: true, facility: targetFac, req });
    } else {
      showNotification('Hospital contact details are currently updating', 'info');
    }
  };

  const updateInventoryItem = async (bloodType: BloodGroup, units: number, flagged: boolean, comment?: string) => {
    const today = new Date();
    today.setDate(today.getDate() + 35);
    const expiresAt = today.toISOString().slice(0, 10);

    // 1. Optimistically update local inventory state immediately so tab switches & UI are instant
    setInventory((prev) => {
      const idx = prev.findIndex((i) => i.bloodType === bloodType);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], units, flagged, expiresAt, comment };
        return next;
      }
      return [
        ...prev,
        {
          id: 'temp-' + bloodType,
          facilityId: user?.facilityId || '',
          bloodType,
          units,
          flagged,
          expiresAt,
          comment,
          updatedAt: new Date().toISOString(),
        },
      ];
    });

    // 2. Persist to DB via REST PUT /api/inventory
    try {
      const res = await fetch(API + '/inventory', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ bloodType, units, expiresAt, flagged, comment }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to update inventory' }));
        showNotification('Error updating inventory: ' + (err.error || 'Server error'), 'error');
        loadData(token);
        return;
      }

      const data = await res.json();
      if (data.item) {
        setInventory((prev) => {
          const idx = prev.findIndex((i) => i.bloodType === bloodType);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = data.item;
            return next;
          }
          return [...prev, data.item];
        });
      }
      showNotification('Updated ' + bloodType + ' stock to ' + units + ' units', 'success');
    } catch (err) {
      console.error('Failed to update inventory via REST', err);
      if (socket.connected) {
        socket.emit('inventory:upsert', { bloodType, units, expiresAt, flagged, comment });
      }
      showNotification('Updated ' + bloodType + ' stock to ' + units + ' units', 'success');
    }
  };

  if (!token || !user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center text-white shadow-lg shadow-red-950/50">
              <BloodDropIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">HemaGrid</h1>
              <p className="text-xs text-slate-400 uppercase tracking-widest font-medium">Real-Time Mutual-Aid Blood Grid</p>
            </div>
          </div>

          <p className="text-slate-300 text-sm mb-6">
            Secure, verified inter-hospital portal for automated smart blood compatibility matching and mutual-aid inventory exchange.
          </p>

          <LoginForm onLogin={login} loading={loading} />

          {notice && (
            <div className={"mt-4 p-3 rounded-lg text-sm border " + (notice.type === "error" ? "bg-red-950 border-red-800 text-red-300" : "bg-emerald-950 border-emerald-800 text-emerald-300")}>
              {notice.message}
            </div>
          )}

          <div className="mt-8 pt-6 border-t border-slate-800">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-2 font-semibold">Select Demo Account</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                onClick={() => login("stmarys@bloodbanc.demo", "password123")}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg text-left border border-slate-700/50"
              >
                <div className="font-semibold text-white">St. Mary's (NY)</div>
                <div className="text-slate-400 text-[10px]">Hospital</div>
              </button>
              <button
                onClick={() => login("brooklyn@bloodbanc.demo", "password123")}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg text-left border border-slate-700/50"
              >
                <div className="font-semibold text-white">Brooklyn Gen (NY)</div>
                <div className="text-slate-400 text-[10px]">Hospital</div>
              </button>
              <button
                onClick={() => login("cedars@bloodbanc.demo", "password123")}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg text-left border border-slate-700/50"
              >
                <div className="font-semibold text-white">Cedars-Sinai (CA)</div>
                <div className="text-slate-400 text-[10px]">Hospital</div>
              </button>
              <button
                onClick={() => login("nycpbb@bloodbanc.demo", "password123")}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg text-left border border-slate-700/50"
              >
                <div className="font-semibold text-white">Presbyterian BB</div>
                <div className="text-slate-400 text-[10px]">Blood Center</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const states = Array.from(new Set(facilities.map((f) => f.state))).sort();
  const filteredFacilities = facilities.filter((f) => {
    const matchesState = selectedStateFilter === "ALL" || f.state === selectedStateFilter;
    const matchesQuery =
      f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.city.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesState && matchesQuery;
  });

  const activeRequestCount = requests.filter((r) => r.status === "OPEN" || r.status === "MATCHED" || r.status === "IN_TRANSIT").length;
  const criticalCount = requests.filter((r) => (r.status === "OPEN" || r.status === "MATCHED") && r.urgency === "CRITICAL").length;
  const totalUnitsInFacility = inventory.reduce((acc, i) => acc + (i.units || 0), 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => setActiveTab("dashboard")}>
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-red-600 to-rose-700 flex items-center justify-center shadow-md shadow-red-950/50">
                <BloodDropIcon className="w-5 h-5 text-white" />
              </div>
              <div>
                <span className="text-lg font-bold text-white tracking-tight">HemaGrid</span>
                <span className="hidden sm:inline-block ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-950 border border-red-800 text-red-400">
                  National Grid
                </span>
              </div>
            </div>

            <nav className="hidden md:flex gap-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setActiveTab("dashboard")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold " + (activeTab === "dashboard" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                Dashboard
              </button>
              <button
                onClick={() => setActiveTab("map")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold " + (activeTab === "map" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                Hospital & Stock Map
              </button>
              <button
                onClick={() => setActiveTab("requests")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 " + (activeTab === "requests" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                Active Transfers
                {activeRequestCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-red-950 text-red-200 border border-red-700">
                    {activeRequestCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("inventory")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold " + (activeTab === "inventory" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                My Vault
              </button>
              <button
                onClick={() => setActiveTab("facilities")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold " + (activeTab === "facilities" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                US Network Directory
              </button>
              <button
                onClick={() => setActiveTab("audit")}
                className={"px-3 py-1.5 rounded-lg text-xs font-semibold " + (activeTab === "audit" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-200")}
              >
                Audit & Compliance
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs bg-slate-800 border border-slate-700 px-3 py-1.5 rounded-lg">
              <div className={"w-2 h-2 rounded-full " + (socketConnected ? "bg-emerald-400" : "bg-red-400")} />
              <span className="text-slate-300 font-medium">{user.facilityName}</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-700 text-slate-300 font-bold">
                {user.role}
              </span>
            </div>

            <button
              onClick={logout}
              className="text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {notice && (
        <div className="fixed top-20 right-6 z-50 max-w-md">
          <div className={"p-4 rounded-xl shadow-2xl border flex items-start gap-3 " + (notice.type === "error" ? "bg-red-950 border-red-800 text-red-200" : "bg-slate-900 border-slate-700 text-slate-200")}>
            <span className="text-xl">{notice.type === "error" ? "⚠️" : "✅"}</span>
            <div className="text-sm font-medium flex-1">{notice.message}</div>
            <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-white text-xs">✕</button>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Active Requests</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-white">{activeRequestCount}</span>
              <span className="text-xs text-slate-500 font-medium">Nationwide</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-1">Critical Alerts</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-red-500">{criticalCount}</span>
              <span className="text-xs text-red-400 font-medium">&lt;15m Response</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Vault Units</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-white">{totalUnitsInFacility}</span>
              <span className="text-xs text-slate-500 font-medium">In Own Vault</span>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Connected Hubs</div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black text-emerald-400">{facilities.length}</span>
              <span className="text-xs text-slate-500 font-medium">50 US States</span>
            </div>
          </div>
        </div>

        {activeTab === "dashboard" && (
          <div className="space-y-8">
            <div className="bg-slate-900 border border-red-950 rounded-2xl p-6 shadow-xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <PulseIcon className="w-5 h-5 text-red-400" />
                    <span>Raise Emergency Blood Request</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Multi-tier automated geo-routing engine. Escalates outward every 120s if unanswered (1hr hard cap).
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  <span>Tier 0 (&lt;10km) ➔ Tier 1 (50km) ➔ Tier 2 (Statewide) ➔ Tier 4 (Nationwide)</span>
                </div>
              </div>
              <QuickRequestForm
                facilities={facilities}
                currentFacilityId={user.facilityId}
                targetFacility={targetFacilityForRequest}
                onClearTargetFacility={() => setTargetFacilityForRequest(null)}
                onCreate={createRequest}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-red-500/15 border border-red-500/30 text-red-400">
                      <AlertBeaconIcon className="w-3.5 h-3.5" />
                    </span>
                    <span>Immediate Action Queue</span>
                  </h3>
                  <button
                    onClick={() => setActiveTab("requests")}
                    className="text-xs text-red-400 hover:text-red-300 font-semibold"
                  >
                    View All ({requests.length}) ➔
                  </button>
                </div>

                {requests.length === 0 ? (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-500 text-sm">
                    No active emergency requests in your quadrant right now.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {requests.slice(0, 5).map((req) => (
                      <RequestCard
                        key={req.id}
                        req={req}
                        currentFacilityId={user.facilityId}
                        onAccept={(id) => respondToMatch(id, "ACCEPT")}
                        onReject={(id, reason) => respondToMatch(id, "REJECT", reason)}
                        onCancel={cancelRequest}
                        onAdvanceTransport={advanceTransport}
                        onCallHospital={handleOpenCallModal}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-400">
                      <BloodDropIcon className="w-3.5 h-3.5" />
                    </span>
                    <span>Vault Stock ({totalUnitsInFacility}u)</span>
                  </h3>
                  <button
                    onClick={() => setActiveTab("inventory")}
                    className="text-xs text-red-400 hover:text-red-300 font-semibold"
                  >
                    Manage ➔
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {BLOOD_GROUPS.map((bt) => {
                    const item = inventory.find((i) => i.bloodType === bt);
                    const units = item ? item.units : 0;
                    return (
                      <div
                        key={bt}
                        className="p-3.5 rounded-xl border bg-slate-900 border-slate-800"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-lg font-black text-white">{bt}</span>
                          {bt === "O-" && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-950 border border-red-800 text-red-300 font-bold">
                              UNIVERSAL
                            </span>
                          )}
                        </div>
                        <div className="flex items-baseline justify-between">
                          <span className="text-2xl font-black text-white">{units}</span>
                          <span className="text-xs text-slate-500 font-medium">units</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 space-y-2">
                  <div className="font-semibold text-slate-200 flex items-center gap-2">
                    <ShieldCheckIcon className="w-4 h-4 text-emerald-400" />
                    <span>Zero-Patient PII Guarantee</span>
                  </div>
                  <p>
                    All requests specify blood type, required units, and expiry parameters only. No patient identity is ever transmitted or stored.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "map" && (
          <HospitalMap
            facilities={facilities}
            currentFacilityId={user.facilityId}
            onSelectFacilityForRequest={(fac) => {
              setTargetFacilityForRequest(fac);
              setActiveTab("dashboard");
              showNotification(`Targeting direct request to ${fac.name} (${fac.city}, ${fac.state})`, "info");
            }}
            onCallFacility={(fac) => setShowCallModal({ open: true, facility: fac, req: null })}
          />
        )}

        {activeTab === "requests" && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">Active Emergency Transfers & Requests</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Live tracking of inter-hospital blood dispatches, courier legs, and escalation stages.
                </p>
              </div>
              <button
                onClick={() => loadData(token)}
                className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 rounded-lg font-semibold flex items-center gap-1.5"
              >
                <RefreshIcon className="w-3.5 h-3.5 text-slate-300" />
                <span>Refresh Live Status</span>
              </button>
            </div>

            <div className="space-y-4">
              {requests.map((req) => (
                <RequestCard
                  key={req.id}
                  req={req}
                  currentFacilityId={user.facilityId}
                  onAccept={(id) => respondToMatch(id, "ACCEPT")}
                  onReject={(id, reason) => respondToMatch(id, "REJECT", reason)}
                  onCancel={cancelRequest}
                  onAdvanceTransport={advanceTransport}
                  onCallHospital={handleOpenCallModal}
                />
              ))}
            </div>
          </div>
        )}

        {activeTab === "inventory" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Hospital Blood Vault & Inventory</h2>
              <p className="text-xs text-slate-400 mt-1">
                Update your facility's real-time reserves. Verified pull-model: other hospitals only see availability via smart-matching algorithms.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {BLOOD_GROUPS.map((bt) => {
                const item = inventory.find((i) => i.bloodType === bt);
                const units = item ? item.units : 0;
                const flagged = item ? item.flagged : false;
                const expiresAt = item ? item.expiresAt : "30 days";

                return (
                  <InventoryCard
                    key={bt}
                    bloodType={bt}
                    units={units}
                    flagged={flagged}
                    expiresAt={expiresAt}
                    onUpdate={(newUnits, newFlagged) => updateInventoryItem(bt, newUnits, newFlagged)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "facilities" && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">US Mutual-Aid Facility Directory</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Geocoded hospital and blood bank hubs enabled for mutual transfer.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  placeholder="Search facility or city..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setFacilityPage(1);
                  }}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                />
                <select
                  value={selectedStateFilter}
                  onChange={(e) => {
                    setSelectedStateFilter(e.target.value);
                    setFacilityPage(1);
                  }}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white"
                >
                  <option value="ALL">All States ({facilities.length.toLocaleString()})</option>
                  {states.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredFacilities.slice(0, facilityPage * 60).map((f) => (
                <div
                  key={f.id}
                  onClick={() => setSelectedFacility(f)}
                  className={"bg-slate-900 border rounded-xl p-4 cursor-pointer " + (selectedFacility?.id === f.id ? "border-red-500" : "border-slate-800")}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-white text-sm">{f.name}</h4>
                      <p className="text-xs text-slate-400">
                        {f.city}, {f.state} · {f.address}
                      </p>
                    </div>
                    <span
                      className={"text-[10px] px-2 py-0.5 rounded font-bold uppercase " + (f.type === "HOSPITAL" ? "bg-blue-950 text-blue-300 border border-blue-800" : "bg-rose-950 text-rose-300 border border-rose-800")}
                    >
                      {f.type}
                    </span>
                  </div>

                  <div className="mt-3 pt-3 border-t border-slate-800 flex items-center justify-between text-xs gap-2">
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <PhoneIcon className="w-3.5 h-3.5 text-slate-500" />
                      <span>{f.phone}</span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      {f.id !== user.facilityId && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setTargetFacilityForRequest(f);
                            setActiveTab('dashboard');
                            showNotification(`Targeting direct request to ${f.name}`, 'info');
                          }}
                          className="bg-red-600 hover:bg-red-500 text-white px-2.5 py-1 rounded text-[11px] font-bold transition cursor-pointer flex items-center gap-1"
                        >
                          <PulseIcon className="w-3 h-3" />
                          <span>Request Blood</span>
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowCallModal({ open: true, facility: f, req: null });
                        }}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer"
                      >
                        Call Desk
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {filteredFacilities.length > facilityPage * 60 && (
              <div className="pt-4 flex justify-center">
                <button
                  onClick={() => setFacilityPage((prev) => prev + 1)}
                  className="bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 px-6 py-2.5 rounded-xl text-xs font-semibold shadow transition cursor-pointer"
                >
                  Load More Hospitals (Showing {Math.min(filteredFacilities.length, facilityPage * 60)} of {filteredFacilities.length.toLocaleString()})
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === "audit" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Compliance & Accountability Trail</h2>
              <p className="text-xs text-slate-400 mt-1">
                Strict audit trail of responses, timeouts, and staff obligations. Holds participating facilities accountable to response SLA (&lt;15m).
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
                    <tr>
                      <th className="py-3.5 px-4">Timestamp</th>
                      <th className="py-3.5 px-4">Event / Action</th>
                      <th className="py-3.5 px-4">Target Blood</th>
                      <th className="py-3.5 px-4">Requester</th>
                      <th className="py-3.5 px-4">Responding Provider</th>
                      <th className="py-3.5 px-4">Tier</th>
                      <th className="py-3.5 px-4">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {auditEvents.map((evt) => {
                      return (
                        <tr key={evt.id} className="hover:bg-slate-800/30">
                          <td className="py-3 px-4 font-mono text-slate-400">
                            {new Date(evt.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </td>
                          <td className="py-3 px-4">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
                              {evt.action}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-bold text-white">
                            {evt.bloodType ? evt.bloodType + " (" + evt.units + "u)" : "—"}
                          </td>
                          <td className="py-3 px-4 text-slate-300">{evt.requesterName || "—"}</td>
                          <td className="py-3 px-4 text-slate-300">{evt.providerName || "Universal Dispatch"}</td>
                          <td className="py-3 px-4 font-mono">Tier {evt.tier}</td>
                          <td className="py-3 px-4 text-slate-400">{evt.detail}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {showCallModal.open && showCallModal.facility && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <PhoneIcon className="w-5 h-5 text-sky-400" />
                <span>Direct Hospital Confirmation Line</span>
              </h3>
              <button
                onClick={() => setShowCallModal({ open: false, facility: null, req: null })}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
              <div className="text-xs text-slate-400 uppercase font-semibold">Facility Name</div>
              <div className="text-base font-bold text-white">{showCallModal.facility.name}</div>
              <div className="text-xs text-slate-400">
                {showCallModal.facility.address}, {showCallModal.facility.city}, {showCallModal.facility.state}
              </div>

              <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                <div className="text-xs text-slate-400">Emergency Desk Phone:</div>
                <div className="text-sm font-bold text-red-400 font-mono">{showCallModal.facility.phone}</div>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Network Protocol: In case of non-response or critical urgency (&lt;15m transport requirement), hospital staff are required to initiate voice confirmation to verify blood packaging and dispatch courier/ambulance.
            </p>

            <div className="flex gap-3 pt-2">
              <a
                href={"tel:" + showCallModal.facility.phone}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white text-center py-2.5 rounded-xl font-bold text-sm"
              >
                Call {showCallModal.facility.phone}
              </a>
              <button
                onClick={() => setShowCallModal({ open: false, facility: null, req: null })}
                className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl font-semibold text-sm"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestCard({
  req,
  currentFacilityId,
  onAccept,
  onReject,
  onCancel,
  onAdvanceTransport,
  onCallHospital,
}: {
  req: RequestWithMeta;
  currentFacilityId: string;
  onAccept: (id: string) => void;
  onReject: (id: string, reason?: string) => void;
  onCancel: (id: string) => void;
  onAdvanceTransport: (id: string, status: 'IN_TRANSIT' | 'FULFILLED') => void;
  onCallHospital: (req: RequestWithMeta) => void;
}) {
  const isRequester = req.requesterId === currentFacilityId;
  const isPendingProvider = !isRequester && req.status === "OPEN" && req.hasPendingMatch !== false;

  const deadline = new Date(req.deadlineAt).getTime();
  const now = Date.now();
  const minsLeft = Math.max(0, Math.round((deadline - now) / 60000));

  return (
    <div className="border rounded-2xl p-5 shadow-lg bg-slate-900 border-slate-800">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-red-950 border border-red-800 flex items-center justify-center">
            <span className="text-xl font-black text-red-400">{req.bloodType}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-white">{req.units} Units Needed</span>
              <span className="text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-red-600 text-white">
                {req.urgency}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Requester: <span className="text-slate-200 font-medium">{req.requesterName || (isRequester ? "My Hospital" : "Partner Hospital")}</span>
              {req.requesterCity && req.requesterState && (
                <span className="text-slate-400 ml-1">({req.requesterCity}, {req.requesterState})</span>
              )} · Tier {req.tier}
            </p>
            {isRequester && (
              <div className="text-xs text-slate-300 mt-1 flex flex-wrap items-center gap-1.5">
                <span className="text-slate-400">Destination:</span>
                {req.providerName ? (
                  <>
                    <strong className="text-emerald-400 font-bold inline-flex items-center gap-1.5">
                      <HospitalIcon className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      <span>{req.providerName}</span>
                    </strong>
                    {req.providerCity && req.providerState && (
                      <span className="text-slate-400">({req.providerCity}, {req.providerState})</span>
                    )}
                    {typeof req.distanceM === 'number' && (
                      <span className="text-[11px] text-blue-400 bg-blue-950/80 border border-blue-800/80 px-1.5 py-0.5 rounded font-mono font-semibold">
                        {(req.distanceM / 1000).toFixed(1)} km away
                      </span>
                    )}
                    {req.providerMatchStatus === 'PENDING' && (
                      <span className="text-[10px] text-amber-300 bg-amber-950/80 border border-amber-700/80 px-1.5 py-0.5 rounded font-bold uppercase animate-pulse">
                        Awaiting Response
                      </span>
                    )}
                    {req.providerMatchStatus === 'ACCEPT' && (
                      <span className="text-[10px] text-emerald-300 bg-emerald-950/80 border border-emerald-700/80 px-1.5 py-0.5 rounded font-bold uppercase">
                        Confirmed Provider
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-amber-400 font-medium inline-flex items-center gap-1.5">
                    <PulseIcon className="w-4 h-4 text-amber-400 animate-pulse flex-shrink-0" />
                    <span>Escalating Tier {req.tier} — searching nearest facilities</span>
                  </span>
                )}
              </div>
            )}
            {!isRequester && req.matchedBloodType && (
              <p className="text-xs text-slate-300 mt-0.5">
                Matched for your base: <strong className="text-white">{req.matchedUnits || req.units} units</strong> of <strong className="text-red-400">{req.matchedBloodType}</strong>
                {req.matchedBloodType !== req.bloodType && (
                  <span className="ml-1 text-amber-400 font-medium">(compatible alternative)</span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div
              className={`inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                req.status === 'CANCELLED'
                  ? 'bg-slate-800 text-slate-400 border border-slate-700'
                  : req.status === 'MATCHED'
                  ? 'bg-blue-950 text-blue-300 border border-blue-800'
                  : req.status === 'IN_TRANSIT'
                  ? 'bg-amber-950 text-amber-300 border border-amber-800'
                  : req.status === 'FULFILLED'
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  : 'bg-red-950 text-red-300 border border-red-800 animate-pulse'
              }`}
            >
              {req.status}
            </div>
            {req.status !== 'CANCELLED' && req.status !== 'FULFILLED' && (
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Hard Cap: {minsLeft}m remaining
              </div>
            )}
          </div>
        </div>
      </div>

      {req.notes && (
        <p className="text-xs text-slate-300 bg-slate-950 p-2.5 rounded-lg border border-slate-800 mb-3">
          <span className="text-slate-500 font-semibold">Clinical Notes:</span> {req.notes}
        </p>
      )}

      <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onCallHospital(req)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <PhoneIcon className="w-3.5 h-3.5 text-sky-400" />
            <span>Call Hospital Desk</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {isPendingProvider && (
            <>
              <button
                onClick={() => onAccept(req.id)}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-4 py-1.5 rounded-lg font-bold shadow transition cursor-pointer"
              >
                Accept & Dispatch Units
              </button>
              <button
                onClick={() => onReject(req.id, "Inventory allocated")}
                className="bg-red-950 border border-red-800 text-red-300 text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-red-900 transition cursor-pointer"
              >
                Decline
              </button>
            </>
          )}

          {req.status === "MATCHED" && (
            <button
              onClick={() => onAdvanceTransport(req.id, "IN_TRANSIT")}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <TruckIcon className="w-3.5 h-3.5 text-sky-200" />
              <span>Courier / Ambulance Dispatched</span>
            </button>
          )}

          {req.status === "IN_TRANSIT" && (
            <button
              onClick={() => onAdvanceTransport(req.id, "FULFILLED")}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5 rounded-lg font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircleIcon className="w-3.5 h-3.5 text-white" />
              <span>Confirm Blood Received</span>
            </button>
          )}

          {isRequester && (req.status === "OPEN" || req.status === "MATCHED") && (
            <button
              onClick={() => onCancel(req.id)}
              className="bg-slate-800 hover:bg-red-950 hover:text-red-300 text-slate-300 border border-slate-700 hover:border-red-800 text-xs px-3 py-1.5 rounded-lg transition font-semibold cursor-pointer"
            >
              ✕ Cancel Request
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function InventoryCard({
  bloodType,
  units,
  flagged,
  expiresAt,
  onUpdate,
}: {
  bloodType: BloodGroup;
  units: number;
  flagged: boolean;
  expiresAt: string;
  onUpdate: (units: number, flagged: boolean) => void;
}) {
  const [val, setVal] = useState(units);
  const [isFlag, setIsFlag] = useState(flagged);

  useEffect(() => {
    setVal(units);
    setIsFlag(flagged);
  }, [units, flagged]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-2xl font-black text-white">{bloodType}</span>
        <span className="text-[10px] text-slate-400 font-mono">Exp: {expiresAt.slice(0, 10)}</span>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => {
            const next = Math.max(0, val - 1);
            setVal(next);
            onUpdate(next, isFlag);
          }}
          className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center"
        >
          -
        </button>
        <span className="text-3xl font-black text-white flex-1 text-center font-mono">{val}</span>
        <button
          onClick={() => {
            const next = val + 1;
            setVal(next);
            onUpdate(next, isFlag);
          }}
          className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center"
        >
          +
        </button>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-slate-800 text-xs">
        <label className="flex items-center gap-2 cursor-pointer text-slate-400">
          <input
            type="checkbox"
            checked={isFlag}
            onChange={(e) => {
              setIsFlag(e.target.checked);
              onUpdate(val, e.target.checked);
            }}
            className="rounded bg-slate-800 border-slate-700 text-red-600"
          />
          Near Expiry Flag
        </label>
      </div>
    </div>
  );
}

function LoginForm({
  onLogin,
  loading,
}: {
  onLogin: (email: string, pw: string) => Promise<void>;
  loading: boolean;
}) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !pw) return;
    onLogin(email, pw);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
          Hospital Staff Email
        </label>
        <input
          className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white placeholder-slate-500 text-sm"
          placeholder="e.g. stmarys@bloodbanc.demo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
          Authorized Key / Password
        </label>
        <input
          className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white placeholder-slate-500 text-sm"
          type="password"
          placeholder="••••••••••••"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-2.5 rounded-xl text-sm"
      >
        {loading ? 'Authenticating...' : 'Sign In to Blood Grid'}
      </button>
    </form>
  );
}

function QuickRequestForm({
  facilities,
  currentFacilityId,
  targetFacility,
  onClearTargetFacility,
  onCreate,
}: {
  facilities: Facility[];
  currentFacilityId: string;
  targetFacility: Facility | null;
  onClearTargetFacility: () => void;
  onCreate: (
    bt: BloodGroup,
    u: number,
    urgency: 'CRITICAL' | 'URGENT' | 'STANDARD',
    notes?: string,
    targetFacilityId?: string,
  ) => void;
}) {
  const [bt, setBt] = useState<BloodGroup>('O-');
  const [units, setUnits] = useState(4);
  const [urgency, setUrgency] = useState<'CRITICAL' | 'URGENT' | 'STANDARD'>('CRITICAL');
  const [notes, setNotes] = useState('');
  const [selectedTargetId, setSelectedTargetId] = useState<string>(targetFacility?.id || '');
  const [searchTargetText, setSearchTargetText] = useState('');

  useEffect(() => {
    setSelectedTargetId(targetFacility ? targetFacility.id : '');
  }, [targetFacility]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(bt, units, urgency, notes, selectedTargetId || undefined);
    setNotes('');
  };

  const currentFac = facilities.find((f) => f.id === currentFacilityId);

  const sortedDestinations = useMemo(() => {
    const others = facilities.filter((f) => f.id !== currentFacilityId);
    if (!currentFac) return others.slice(0, 80);

    const getDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      if (!lat1 || !lon1 || !lat2 || !lon2) return 999999;
      const R = 6371;
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const withDist = others.map((f) => ({
      ...f,
      distKm: getDistanceKm(currentFac.lat, currentFac.lng, f.lat, f.lng),
    }));

    withDist.sort((a, b) => a.distKm - b.distKm);

    if (searchTargetText.trim()) {
      const q = searchTargetText.toLowerCase().trim();
      const filtered = withDist.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.city.toLowerCase().includes(q) ||
          f.state.toLowerCase() === q ||
          f.address.toLowerCase().includes(q)
      );
      if (selectedTargetId) {
        const found = withDist.find((f) => f.id === selectedTargetId);
        if (found && !filtered.some((f) => f.id === selectedTargetId)) {
          filtered.unshift(found);
        }
      }
      return filtered.slice(0, 100);
    }

    const sliced = withDist.slice(0, 80);
    if (selectedTargetId && !sliced.some((f) => f.id === selectedTargetId)) {
      const found = withDist.find((f) => f.id === selectedTargetId);
      if (found) sliced.unshift(found);
    }
    return sliced;
  }, [facilities, currentFacilityId, currentFac, searchTargetText, selectedTargetId]);

  const targetedFac = facilities.find((f) => f.id === selectedTargetId);

  return (
    <div className="space-y-3">
      {targetedFac && (
        <div className="bg-red-950/60 border border-red-800 rounded-xl p-3 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <HospitalIcon className="w-4 h-4 text-red-400 flex-shrink-0" />
            <div>
              <span className="font-bold text-white">Direct Targeted Dispatch: </span>
              <span className="text-red-300 font-semibold">{targetedFac.name} ({targetedFac.city}, {targetedFac.state})</span>
              <span className="text-slate-400 ml-2 text-[11px]">· Will bypass distance rings and alert this hospital directly</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelectedTargetId('');
              onClearTargetFacility();
            }}
            className="text-red-400 hover:text-white bg-red-900/40 hover:bg-red-900 border border-red-700/60 px-2 py-1 rounded text-[11px] font-semibold transition cursor-pointer"
          >
            ✕ Switch to Auto-Match
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-slate-300">
                Routing Destination <span className="text-red-400">*</span>
              </label>
              {currentFac && (
                <span className="text-[10px] text-slate-400">
                  Near {currentFac.city}, {currentFac.state}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              <select
                value={selectedTargetId}
                onChange={(e) => {
                  setSelectedTargetId(e.target.value);
                  if (!e.target.value) onClearTargetFacility();
                }}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white font-semibold focus:border-red-500 focus:outline-none"
              >
                <option value="">Auto-Match Nearest (Geo-Escalation Engine)</option>
                {sortedDestinations.map((fac: any) => (
                  <option key={fac.id} value={fac.id}>
                    {fac.type === 'HOSPITAL' ? '[Hospital]' : '[Blood Center]'} {fac.name} {typeof fac.distKm === 'number' && fac.distKm < 9999 ? `(${fac.distKm.toFixed(1)} km · ${fac.city}, ${fac.state})` : `(${fac.city}, ${fac.state})`}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Search hospital or state to target..."
                value={searchTargetText}
                onChange={(e) => setSearchTargetText(e.target.value)}
                className="w-full bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1 text-[11px] text-slate-300 placeholder-slate-500 focus:border-red-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Required Blood Group</label>
            <select
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-bold"
              value={bt}
              onChange={(e) => setBt(e.target.value as BloodGroup)}
            >
              {BLOOD_GROUPS.map((t) => (
                <option key={t} value={t}>
                  {t} {t === 'O-' ? '(Universal Donor)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Units Needed (1 - 200)</label>
            <input
              type="number"
              min="1"
              max="200"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-bold"
              value={units}
              onChange={(e) => setUnits(Number(e.target.value))}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">SLA Urgency Level</label>
            <select
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white font-bold"
              value={urgency}
              onChange={(e) => setUrgency(e.target.value as any)}
            >
              <option value="CRITICAL">CRITICAL (&lt;15 min ETA — Emergency Trauma)</option>
              <option value="URGENT">URGENT (&lt;30 min ETA — Rapid Surgery)</option>
              <option value="STANDARD">STANDARD (&lt;1 hr ETA — Scheduled Care)</option>
            </select>
          </div>
        </div>

        {targetedFac && (
          <div
            className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
              (targetedFac.inventory?.find((i) => i.bloodType === bt)?.units ?? 0) >= units
                ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                : 'bg-amber-950/50 border-amber-700 text-amber-200'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="flex-shrink-0">
                {(targetedFac.inventory?.find((i) => i.bloodType === bt)?.units ?? 0) >= units ? (
                  <CheckCircleIcon className="w-4 h-4 text-emerald-400" />
                ) : (
                  <AlertTriangleIcon className="w-4 h-4 text-amber-400" />
                )}
              </span>
              <span>
                <strong>{targetedFac.name}</strong> has{' '}
                <strong>{targetedFac.inventory?.find((i) => i.bloodType === bt)?.units ?? 0} unit(s)</strong> of {bt} in vault inventory.
              </span>
            </div>
            {(targetedFac.inventory?.find((i) => i.bloodType === bt)?.units ?? 0) < units && (
              <span className="text-[11px] text-amber-300 font-semibold">
                (Insufficient for {units}u request)
              </span>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">Clinical / Transport Notes</label>
            <input
              type="text"
              placeholder="Optional: Clinical transport instructions (e.g. ICU Bay 4 trauma transfer)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-300 placeholder-slate-500"
            />
          </div>

          <div>
            <button
              type="submit"
              className="w-full bg-gradient-to-r from-red-600 to-rose-700 hover:from-red-500 hover:to-rose-600 text-white font-bold py-2.5 px-4 rounded-xl text-sm transition shadow-lg cursor-pointer flex items-center justify-center gap-2"
            >
              <SendIcon className="w-4 h-4 text-white" />
              <span>{selectedTargetId ? 'Dispatch Direct' : 'Dispatch Auto-Match'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
