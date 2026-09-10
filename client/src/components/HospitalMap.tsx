import { useState, useMemo, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import { BLOOD_GROUPS, type Facility } from '@bloodbanc/shared';

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function createMarkerIcon(isCurrent: boolean, type: string, hasRequestedStock: boolean) {
  const bg = isCurrent
    ? '#10b981'
    : hasRequestedStock
    ? '#ef4444'
    : type === 'HOSPITAL'
    ? '#3b82f6'
    : '#8b5cf6';

  const iconText = isCurrent ? '📍' : type === 'HOSPITAL' ? '🏥' : '🩸';
  const pulseClass = isCurrent ? 'animate-pulse' : '';

  return L.divIcon({
    className: 'custom-facility-pin',
    html: `
      <div style="
        background-color: ${bg};
        width: 38px;
        height: 38px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2.5px solid #ffffff;
        box-shadow: 0 4px 14px rgba(0,0,0,0.5);
        cursor: pointer;
        position: relative;
      " class="${pulseClass}">
        <span style="font-size: 18px;">${iconText}</span>
        ${isCurrent ? '<span style="position: absolute; top: -2px; right: -2px; width: 10px; height: 10px; border-radius: 50%; background: #34d399; border: 2px solid #fff;"></span>' : ''}
      </div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -22],
  });
}

function FlyToSelected({ coords, zoom }: { coords: [number, number] | null; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (coords) {
      map.flyTo(coords, zoom, { duration: 1.2 });
    }
  }, [coords, zoom, map]);
  return null;
}

interface HospitalMapProps {
  facilities: Facility[];
  currentFacilityId: string;
  onSelectFacilityForRequest: (facility: Facility) => void;
  onCallFacility: (facility: Facility) => void;
}

export function HospitalMap({
  facilities,
  currentFacilityId,
  onSelectFacilityForRequest,
  onCallFacility,
}: HospitalMapProps) {
  const currentFacility = useMemo(
    () => facilities.find((f) => f.id === currentFacilityId),
    [facilities, currentFacilityId],
  );

  const [selectedBloodType, setSelectedBloodType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedState, setSelectedState] = useState('ALL');
  const [focusedFacility, setFocusedFacility] = useState<Facility | null>(null);
  const [showRings, setShowRings] = useState(true);

  const defaultCenter: [number, number] = useMemo(() => {
    if (currentFacility?.lat && currentFacility?.lng) {
      return [currentFacility.lat, currentFacility.lng];
    }
    return [39.8283, -98.5795]; // Geographical center of USA
  }, [currentFacility]);

  // States list for filter
  const states = useMemo(() => {
    return Array.from(new Set(facilities.map((f) => f.state))).sort();
  }, [facilities]);

  // Compute facility metadata with distance and filtered stock
  const facilityListWithDistance = useMemo(() => {
    return facilities.map((f) => {
      let distKm = 0;
      if (currentFacility?.lat && currentFacility?.lng && f.lat && f.lng) {
        distKm = haversineDistanceKm(currentFacility.lat, currentFacility.lng, f.lat, f.lng);
      }
      const totalUnits = (f.inventory || []).reduce((sum, item) => sum + (item.units || 0), 0);
      const matchingStock =
        selectedBloodType === 'ALL'
          ? totalUnits
          : (f.inventory || []).find((i) => i.bloodType === selectedBloodType)?.units || 0;

      return {
        ...f,
        distKm,
        totalUnits,
        matchingStock,
      };
    }).sort((a, b) => {
      if (a.id === currentFacilityId) return -1;
      if (b.id === currentFacilityId) return 1;
      return a.distKm - b.distKm;
    });
  }, [facilities, currentFacility, currentFacilityId, selectedBloodType]);

  // Filter facilities
  const filteredFacilities = useMemo(() => {
    return facilityListWithDistance.filter((f) => {
      const matchState = selectedState === 'ALL' || f.state === selectedState;
      const matchQuery =
        f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        f.city.toLowerCase().includes(searchQuery.toLowerCase());
      const matchStock = selectedBloodType === 'ALL' || f.matchingStock > 0;
      return matchState && matchQuery && matchStock;
    });
  }, [facilityListWithDistance, selectedState, searchQuery, selectedBloodType]);

  // Performance optimization: Render top closest facilities on Leaflet pins to prevent DOM lag
  const mapDisplayFacilities = useMemo(() => {
    const subset = filteredFacilities.slice(0, 250);
    if (currentFacility && !subset.some((f) => f.id === currentFacility.id)) {
      subset.unshift(currentFacility as any);
    }
    return subset;
  }, [filteredFacilities, currentFacility]);

  return (
    <div className="space-y-4">
      {/* Map Header & Filter Controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <span className="text-2xl">🗺️</span> National Hospital & Blood Stock Radar
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Real-time PostGIS geolocated hospital nodes. Click any facility on the map to inspect live vault inventory or directly dispatch an emergency request.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowRings(!showRings)}
              className={"text-xs px-3 py-1.5 rounded-lg border font-semibold transition " + (showRings ? "bg-red-950/80 border-red-800 text-red-300" : "bg-slate-800 border-slate-700 text-slate-400")}
            >
              {showRings ? "🔘 Geo-Escalation Radii ON" : "⚪ Geo Radii Hidden"}
            </button>

            {currentFacility && (
              <button
                onClick={() => setFocusedFacility(currentFacility)}
                className="text-xs bg-emerald-950 hover:bg-emerald-900 border border-emerald-800 text-emerald-300 px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1"
              >
                <span>📍</span> Center On My Hospital
              </button>
            )}
          </div>
        </div>

        {/* Filter controls */}
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-xs">
          <div>
            <label className="block text-slate-400 font-semibold mb-1">Filter by Blood Stock:</label>
            <select
              value={selectedBloodType}
              onChange={(e) => setSelectedBloodType(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-bold"
            >
              <option value="ALL">All Blood Types ({facilities.length} hubs)</option>
              {BLOOD_GROUPS.map((bt) => (
                <option key={bt} value={bt}>
                  {bt} {bt === 'O-' ? '(Universal Donor)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1">Filter by State:</label>
            <select
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-semibold"
            >
              <option value="ALL">All States ({states.length} states)</option>
              {states.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-1 lg:col-span-2">
            <label className="block text-slate-400 font-semibold mb-1">Search Facilities:</label>
            <input
              type="text"
              placeholder="Search hospital name, city, or address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white placeholder-slate-500"
            />
          </div>
        </div>
      </div>

      {/* Main Map + Side Panel Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Interactive Leaflet Map Container */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
          <div className="h-[580px] w-full relative z-10">
            <MapContainer
              center={defaultCenter}
              zoom={currentFacility?.lat ? 5 : 4}
              scrollWheelZoom={true}
              className="h-full w-full"
              style={{ background: '#090d16' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />

              <FlyToSelected
                coords={focusedFacility?.lat && focusedFacility?.lng ? [focusedFacility.lat, focusedFacility.lng] : null}
                zoom={7}
              />

              {/* Geo-routing Escalation Radii around Current Facility */}
              {showRings && currentFacility?.lat && currentFacility?.lng && (
                <>
                  <Circle
                    center={[currentFacility.lat, currentFacility.lng]}
                    radius={10000}
                    pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.12, weight: 1.5 }}
                  />
                  <Circle
                    center={[currentFacility.lat, currentFacility.lng]}
                    radius={50000}
                    pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08, weight: 1.2 }}
                  />
                  <Circle
                    center={[currentFacility.lat, currentFacility.lng]}
                    radius={250000}
                    pathOptions={{ color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.04, weight: 1 }}
                  />
                  <Circle
                    center={[currentFacility.lat, currentFacility.lng]}
                    radius={1000000}
                    pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.02, weight: 1, dashArray: '4, 8' }}
                  />
                </>
              )}

              {/* Facility Markers (nearest 250 for silky 60fps performance) */}
              {mapDisplayFacilities.map((fac) => {
                if (!fac.lat || !fac.lng) return null;
                const isCurrent = fac.id === currentFacilityId;
                const hasRequestedStock = selectedBloodType !== 'ALL' && fac.matchingStock > 0;

                return (
                  <Marker
                    key={fac.id}
                    position={[fac.lat, fac.lng]}
                    icon={createMarkerIcon(isCurrent, fac.type, hasRequestedStock)}
                  >
                    <Popup className="custom-popup" minWidth={280} maxWidth={320}>
                      <div className="p-1 text-slate-900 font-sans">
                        <div className="flex items-start justify-between gap-2 border-b pb-2 mb-2">
                          <div>
                            <div className="font-extrabold text-sm text-slate-900 leading-tight">{fac.name}</div>
                            <div className="text-[11px] text-slate-500">{fac.city}, {fac.state}</div>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                            isCurrent
                              ? 'bg-emerald-100 text-emerald-800'
                              : fac.type === 'HOSPITAL'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-purple-100 text-purple-800'
                          }`}>
                            {isCurrent ? 'Your Hospital' : fac.type}
                          </span>
                        </div>

                        <div className="text-xs text-slate-600 mb-2 space-y-0.5">
                          <div>📍 {fac.address}</div>
                          <div>📞 <a href={`tel:${fac.phone}`} className="text-blue-600 font-semibold">{fac.phone}</a></div>
                          {fac.distKm > 0 && (
                            <div className="font-semibold text-slate-700">
                              🚗 {fac.distKm.toLocaleString()} km ({Math.round(fac.distKm * 0.621371).toLocaleString()} mi) from your base
                            </div>
                          )}
                        </div>

                        {/* Blood stock badges */}
                        <div className="mb-3">
                          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Vault Inventory Stock</div>
                          <div className="grid grid-cols-4 gap-1 text-[11px]">
                            {BLOOD_GROUPS.map((bt) => {
                              const units = (fac.inventory || []).find((i) => i.bloodType === bt)?.units || 0;
                              const isTarget = selectedBloodType === bt;
                              return (
                                <div
                                  key={bt}
                                  className={`p-1 rounded text-center border font-mono ${
                                    isTarget
                                      ? 'bg-red-50 border-red-500 text-red-700 font-bold ring-1 ring-red-400'
                                      : units > 0
                                      ? 'bg-slate-100 border-slate-200 text-slate-800 font-semibold'
                                      : 'bg-slate-50 border-slate-100 text-slate-400'
                                  }`}
                                >
                                  <div>{bt}</div>
                                  <div className="text-[10px] font-bold">{units}u</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="space-y-1.5 pt-1 border-t">
                          {!isCurrent && (
                            <button
                              onClick={() => onSelectFacilityForRequest(fac)}
                              className="w-full bg-red-600 hover:bg-red-700 text-white font-bold text-xs py-2 px-3 rounded-lg shadow transition flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <span>⚡</span> Request Blood From This Facility
                            </button>
                          )}
                          <button
                            onClick={() => onCallFacility(fac)}
                            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs py-1.5 px-3 rounded-lg font-medium transition cursor-pointer"
                          >
                            📞 Direct Desk Confirmation
                          </button>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          {/* Map Legend */}
          <div className="p-3 bg-slate-950 border-t border-slate-800 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-2">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" /> Your Facility
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-blue-500 inline-block" /> Hospital Hub
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-purple-500 inline-block" /> Blood Center
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500 inline-block" /> Stock Matched
              </span>
            </div>
            <div className="text-[11px] text-slate-500">
              Showing {mapDisplayFacilities.length} nearest pins of {filteredFacilities.length.toLocaleString()} matching ({facilities.length.toLocaleString()} nationwide)
            </div>
          </div>
        </div>

        {/* Sidebar: Facilities Directory sorted by Distance */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col h-[640px]">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
            <div>
              <h3 className="font-bold text-white text-sm">Nearby Facilities</h3>
              <p className="text-[11px] text-slate-400">Ordered by proximity from your base</p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-800 text-slate-300">
              {filteredFacilities.length.toLocaleString()}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {filteredFacilities.slice(0, 100).map((fac) => {
              const isCurrent = fac.id === currentFacilityId;
              const isFocused = focusedFacility?.id === fac.id;

              return (
                <div
                  key={fac.id}
                  onClick={() => setFocusedFacility(fac)}
                  className={`p-3 rounded-xl border transition cursor-pointer ${
                    isFocused
                      ? 'bg-slate-800 border-red-500 shadow-md'
                      : isCurrent
                      ? 'bg-emerald-950/40 border-emerald-800 hover:bg-emerald-950/60'
                      : 'bg-slate-950 border-slate-800 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-1 mb-1">
                    <div>
                      <div className="font-bold text-white text-xs leading-snug flex items-center gap-1">
                        {fac.name}
                        {isCurrent && (
                          <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.2 rounded font-bold">
                            YOU
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {fac.city}, {fac.state} · {fac.distKm > 0 ? `${fac.distKm.toLocaleString()} km` : '0 km'}
                      </div>
                    </div>

                    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-slate-800 text-slate-300">
                      {fac.type === 'HOSPITAL' ? 'HOSP' : 'CENTER'}
                    </span>
                  </div>

                  {/* Stock highlight */}
                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">
                      Vault Total: <strong className="text-white">{fac.totalUnits}u</strong>
                    </span>
                    {selectedBloodType !== 'ALL' && (
                      <span className="text-red-400 font-bold">
                        {selectedBloodType}: {fac.matchingStock}u
                      </span>
                    )}
                  </div>

                  {/* Action buttons inside card */}
                  {!isCurrent && (
                    <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectFacilityForRequest(fac);
                        }}
                        className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold text-[11px] py-1 px-2.5 rounded-lg transition cursor-pointer"
                      >
                        ⚡ Request Blood
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onCallFacility(fac);
                        }}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] py-1 px-2 rounded-lg cursor-pointer"
                      >
                        📞 Call
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
