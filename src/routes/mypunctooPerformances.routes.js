const express = require("express");
const { pool } = require("../db");

const router = express.Router();

/**
 * Helpers
 */
function toLowerEmail(emailRaw) {
  return (emailRaw || "").toString().trim().toLowerCase();
}

function parseDateOnlyToIsoStart(dateStr) {
  // dateStr: "YYYY-MM-DD" -> "YYYY-MM-DDT00:00:00.000Z"
  // We keep it simple: treat as UTC date boundary for now.
  // (Later: can align with Europe/Brussels if/when you want.)
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return `${s}T00:00:00.000Z`;
}

function minutesDiff(startIso, endIso) {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ms = b - a;
  if (ms < 0) return null;
  return Math.round(ms / 60000);
}

/**
 * Context helpers (same gating pattern as your other mypunctoo routes)
 */
async function getEnabledCustomerByEmail(emailRaw) {
  const email = toLowerEmail(emailRaw);
  if (!email) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "email query param is required" },
    };
  }

  const cQ = `
    SELECT client_id, client_type, company_name, email, mypunctoo_enabled, mypunctoo_enabled_at
    FROM client
    WHERE client_type = 'CUSTOMER' AND email = $1
    LIMIT 1
  `;
  const cR = await pool.query(cQ, [email]);

  if (cR.rowCount === 0) {
    return {
      ok: false,
      status: 404,
      body: { ok: true, allowed: false, reason: "NO_CUSTOMER_ACCOUNT" },
    };
  }

  const client = cR.rows[0];

  if (!client.mypunctoo_enabled) {
    return {
      ok: false,
      status: 200,
      body: { ok: true, allowed: false, reason: "NOT_ENABLED_YET", client_id: client.client_id },
    };
  }

  return { ok: true, client };
}

async function getMypunctooContext(emailRaw) {
  const g = await getEnabledCustomerByEmail(emailRaw);
  if (!g.ok) return g;

  const client = g.client;

  const sQ = `
    SELECT scantag_id, qr_url_in, qr_url_out, status, created_at
    FROM scantag
    WHERE client_id = $1 AND status = 'ACTIVE'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const sR = await pool.query(sQ, [client.client_id]);

  if (sR.rowCount === 0) {
    return {
      ok: false,
      status: 200,
      body: { ok: true, allowed: false, reason: "NO_ACTIVE_SCANTAG", client_id: client.client_id },
    };
  }

  return { ok: true, client, scantag: sR.rows[0] };
}

/**
 * Build "aanwezigheidsprestaties" per employee from scan events.
 * - A performance ideally starts at an IN and ends at the next OUT.
 * - If OUT occurs without an open IN -> standalone attention record.
 * - If IN occurs while already open -> attention (we keep the open one).
 */
function buildPerformancesFromEvents(events) {
  const performances = [];
  let open = null;

  function makeBasePerformance() {
    return {
      started_at: null,
      ended_at: null,
      effective_minutes: null,

      registration_complete: false, // full IN+OUT present
      measurable: false,            // IN & OUT are measurement_valid=true
      attention: true,              // default for incomplete/invalid
      attention_reasons: [],

      start_event_id: null,
      end_event_id: null,
      start_measurement_valid: null,
      end_measurement_valid: null,
      start_anomaly_code: null,
      end_anomaly_code: null,
    };
  }

  for (const ev of events) {
    const direction = ev.direction;
    const measurementValid = ev.measurement_valid === true; // normalize
    const anomalyCode = ev.anomaly_code || null;

    if (direction === "IN") {
      if (!open) {
        open = {
          ev,
          extra_in_while_open: 0,
        };
      } else {
        // IN while already open -> attention signal
        open.extra_in_while_open += 1;
      }
      continue;
    }

    if (direction === "OUT") {
      if (open) {
        const start = open.ev;
        const end = ev;

        const p = makeBasePerformance();
        p.started_at = start.scanned_at;
        p.ended_at = end.scanned_at;
        p.start_event_id = start.scan_event_id;
        p.end_event_id = end.scan_event_id;

        p.start_measurement_valid = start.measurement_valid === true;
        p.end_measurement_valid = end.measurement_valid === true;
        p.start_anomaly_code = start.anomaly_code || null;
        p.end_anomaly_code = end.anomaly_code || null;

        p.registration_complete = true;

        // "measurable" only if both are measurement_valid=true
        p.measurable = (start.measurement_valid === true) && (end.measurement_valid === true);

        // effective_minutes: we can compute it always, but only "trusted" if measurable
        const mins = minutesDiff(start.scanned_at, end.scanned_at);
        p.effective_minutes = mins;

        // attention rules: any invalid, any anomaly_code, or extra IN while open
        p.attention = false;
        if (!p.measurable) {
          p.attention = true;
          p.attention_reasons.push("NOT_MEASURABLE");
        }
        if (p.start_anomaly_code) {
          p.attention = true;
          p.attention_reasons.push(`START_${p.start_anomaly_code}`);
        }
        if (p.end_anomaly_code) {
          p.attention = true;
          p.attention_reasons.push(`END_${p.end_anomaly_code}`);
        }
        if (open.extra_in_while_open > 0) {
          p.attention = true;
          p.attention_reasons.push("IN_WHILE_OPEN");
        }

        performances.push(p);
        open = null;
      } else {
        // OUT without any open IN -> attention record
        const p = makeBasePerformance();
        p.ended_at = ev.scanned_at;
        p.end_event_id = ev.scan_event_id;
        p.end_measurement_valid = measurementValid;
        p.end_anomaly_code = anomalyCode;

        p.attention = true;
        p.attention_reasons.push("OUT_WITHOUT_IN");

        if (!measurementValid) p.attention_reasons.push("NOT_MEASURABLE");
        if (anomalyCode) p.attention_reasons.push(`END_${anomalyCode}`);

        performances.push(p);
      }
      continue;
    }

    // Any unknown direction -> ignore safely
  }

  // If still open -> open performance (IN without OUT)
  if (open) {
    const start = open.ev;
    const p = makeBasePerformance();
    p.started_at = start.scanned_at;
    p.start_event_id = start.scan_event_id;
    p.start_measurement_valid = start.measurement_valid === true;
    p.start_anomaly_code = start.anomaly_code || null;

    p.registration_complete = false;
    p.measurable = false;
    p.attention = true;
    p.attention_reasons.push("OPEN_SHIFT");
    if (open.extra_in_while_open > 0) p.attention_reasons.push("IN_WHILE_OPEN");
    if (p.start_anomaly_code) p.attention_reasons.push(`START_${p.start_anomaly_code}`);
    if (p.start_measurement_valid === false) p.attention_reasons.push("NOT_MEASURABLE");

    performances.push(p);
  }

  return performances;
}

/**
 * GET /api/mypunctoo/performances?email=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Notes:
 * - This endpoint is read-only and purely factual (no referentieduur / no over-time yet).
 * - It returns "aanwezigheidsprestaties" per employee.
 */
router.get("/performances", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const clientId = ctx.client.client_id;

    // Optional date range (UTC boundaries for now)
    const fromIso = parseDateOnlyToIsoStart(req.query.from);
    const toIso = parseDateOnlyToIsoStart(req.query.to);

    // Employees for this client
    const eQ = `
      SELECT employee_id, first_name, last_name, email, created_at
      FROM employee
      WHERE client_id = $1
      ORDER BY last_name ASC, first_name ASC
    `;
    const eR = await pool.query(eQ, [clientId]);
    const employees = eR.rows || [];

    if (employees.length === 0) {
      return res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        employees: [],
      });
    }

    const employeeIds = employees.map((e) => e.employee_id);

    // Fetch scan events for all employees in one go (optionally filtered by date range)
    // We keep ordering stable for pairing.
    let seQ = `
      SELECT
        se.scan_event_id,
        se.employee_id,
        se.scanned_at,
        se.direction,
        se.measurement_valid,
        se.anomaly_code,
        COALESCE(se.is_system, false) AS is_system,
        se.created_at
      FROM public.scan_event se
      WHERE se.employee_id = ANY($1)
    `;
    const params = [employeeIds];

    if (fromIso) {
      params.push(fromIso);
      seQ += ` AND se.scanned_at >= $${params.length} `;
    }
    if (toIso) {
      params.push(toIso);
      seQ += ` AND se.scanned_at < $${params.length} `;
    }

    seQ += `
      ORDER BY se.employee_id ASC, se.scanned_at ASC, se.created_at ASC, se.scan_event_id ASC
    `;

    const seR = await pool.query(seQ, params);
    const allEvents = seR.rows || [];

    // Group events per employee
    const eventsByEmployee = new Map();
    for (const ev of allEvents) {
      if (!eventsByEmployee.has(ev.employee_id)) eventsByEmployee.set(ev.employee_id, []);
      eventsByEmployee.get(ev.employee_id).push(ev);
    }

    // Build performances per employee
    const outEmployees = employees.map((e) => {
      const evs = eventsByEmployee.get(e.employee_id) || [];
      const performances = buildPerformancesFromEvents(evs);

      return {
        employee_id: e.employee_id,
        first_name: e.first_name,
        last_name: e.last_name,
        email: e.email,
        display_name: `${(e.first_name || "").trim()} ${(e.last_name || "").trim()}`.trim(),
        performances,
      };
    });

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      from: fromIso || null,
      to: toIso || null,
      employees: outEmployees,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
