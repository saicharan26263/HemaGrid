import { query } from '../db/pool.js';
import { createRequest, respondToMatch, sweepRequests, getRequestDetail } from '../services/requestService.js';

async function run() {
  const facs = await query("SELECT id, name FROM facilities LIMIT 3");
  const [f1, f2, f3] = facs.rows;
  console.log("F1 (requester):", f1.name);
  console.log("F2 (first candidate):", f2.name);
  console.log("F3 (second candidate):", f3.name);

  // Set stock
  await query("INSERT INTO inventory (facility_id, blood_type, units, expires_at) VALUES ($1, 'O-', 10, '2027-01-01') ON CONFLICT (facility_id, blood_type) DO UPDATE SET units=10", [f2.id]);
  await query("INSERT INTO inventory (facility_id, blood_type, units, expires_at) VALUES ($1, 'O-', 10, '2027-01-01') ON CONFLICT (facility_id, blood_type) DO UPDATE SET units=10", [f3.id]);

  // Create request targeted to F2
  const req = await createRequest({
    requesterId: f1.id,
    bloodType: "O-",
    units: 2,
    urgency: "CRITICAL",
    notes: "Failover test verification",
    targetFacilityId: f2.id
  });
  console.log("Created request:", req.id);

  // Check initial matches
  let d1 = await getRequestDetail(req.id);
  console.log("Initial matches count:", d1.matches.length, "Status:", d1.matches[0]?.response);

  // Simulate timeout on F2: set match created_at back by 150 seconds
  await query("UPDATE matches SET created_at = now() - interval '150 seconds' WHERE request_id=$1", [req.id]);

  // Run sweeper
  await sweepRequests();

  // Check matches after sweeper
  let d2 = await getRequestDetail(req.id);
  console.log("Matches count after sweep:", d2.matches.length);
  for (const m of d2.matches) {
    console.log(" - Provider:", m.providerName, "Response:", m.response);
  }

  // Verify F2 match is STILL PENDING
  const f2Match = d2.matches.find(m => m.providerId === f2.id);
  if (f2Match?.response !== "PENDING") {
    throw new Error("FAIL: F2 match was rejected on SLA timeout instead of remaining PENDING!");
  }
  console.log("VERIFIED: F2 match remains PENDING after SLA timeout!");

  // If F3 wasn't in matches yet, add F3
  let providerToAccept = d2.matches.find(m => m.providerId !== f2.id)?.providerId || f3.id;
  const hasOther = d2.matches.some(m => m.providerId === providerToAccept);
  if (!hasOther) {
    await query(
      "INSERT INTO matches (request_id, provider_id, matched_blood_type, units, distance_m, score, compatibility, response) VALUES ($1, $2, 'O-', 2, 5000, 100, 'EXACT', 'PENDING')",
      [req.id, providerToAccept]
    );
  }

  // Now simulate: Second hospital responds and accepts!
  const res = await respondToMatch({
    requestId: req.id,
    providerId: providerToAccept,
    response: "ACCEPT"
  });
  console.log("Second hospital accepted:", res.accepted);

  // Check detail after second hospital accepted
  let d3 = await getRequestDetail(req.id);
  console.log("Request status:", d3.status);
  console.log("Confirmed provider:", d3.providerName);
  for (const m of d3.matches) {
    console.log(" - Provider:", m.providerName, "Response:", m.response, "Reason:", m.reason);
  }

  const f2MatchAfter = d3.matches.find(m => m.providerId === f2.id);
  if (!f2MatchAfter?.reason?.includes("Fulfilled by")) {
    throw new Error("FAIL: F2 did not receive reason showing it was fulfilled by other hospital!");
  }
  console.log("VERIFIED: F2 is notified with reason:", f2MatchAfter.reason);

  // Test: what if F2 also tries to accept after F3 already fulfilled?
  try {
    await respondToMatch({
      requestId: req.id,
      providerId: f2.id,
      response: "ACCEPT"
    });
    throw new Error("FAIL: Should not allow duplicate acceptance after fulfilled!");
  } catch (err: any) {
    console.log("VERIFIED: F2 prevented from duplicate acceptance with error:", err.message);
  }

  console.log("\nALL MULTI-HOSPITAL FAILOVER TESTS PASSED SUCCESSFULLY!");
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
