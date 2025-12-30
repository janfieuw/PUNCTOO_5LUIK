const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// -----------------------------
// Scan Rules v1 constants
// -----------------------------
const DOUBLE_TAP_WINDOW_SECONDS = 10; // ignore (no insert)
const COOLDOWN_AFTER_OUT_MINUTES = 60; // deny (409)

// helpers (lokaal, zodat deze file zelfstandig werkt)
function normalizeIp(req) {
  const raw = req.ip || "";
  return raw.startsWith("::ffff:") ? raw.replace("::ffff:", "") : raw;
}

function toLowerEmail(emailRaw) {
  return (emailRaw || "").toString().trim().toLowerCase();
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function diffSeconds(a, b) {
  // a - b in seconds
  return Math.floor((a.getTime() - b.getTime()) / 1000);
}

function deriveStatusAfterFromLatestEventRow(row) {
  // Treat OUT_WITHOUT_IN as "IN" for status purposes (as agreed)
  if (!row) return null;
  if (row.anomaly_code === "OUT_WITHOUT_IN") return "IN";
  return row.direction;
}

// -----------------------------
// Context helpers (unchanged)
// -----------------------------
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

async function requireEmployeeBelongsToClient(employee_id, client_id, dbClient = null) {
  const q = `
    SELECT employee_id
    FROM employee
    WHERE employee_id = $1 AND client_id = $2
    LIMIT 1
  `;
  const runner = dbClient || pool;
  const r = await runner.query(q, [employee_id, client_id]);
  if (r.rowCount === 0) {
    return { ok: false, status: 404, body: { ok: false, error: "employee not found" } };
  }
  return { ok: true };
}

// -----------------------------
// SQL blocks (runtime)
// -----------------------------
const SQL_LAST_EVENT_FOR_UPDATE = `
  SELECT
    scan_event_id,
    direction,
    scanned_at,
    anomaly_code,
    measurement_valid,
    is_system,
    created_at
  FROM public.scan_event
  WHERE employee_id = $1
  ORDER BY scanned_at DESC, created_at DESC, scan_event_id DESC
  LIMIT 1
  FOR UPDATE;
`;

const SQL_INSERT_EVENT = `
  INSERT INTO public.scan_event (
    scan_event_id,
    client_id,
    scantag_id,
    employee_id,
    direction,
    scanned_at,
    source,
    user_agent,
    ip_address,
    anomaly_code,
    measurement_valid,
    is_system,
    created_at
  )
  VALUES (
    gen_random_uuid(),
    $1,
    $2,
    $3,
    $4::public.scan_direction,
    $5,
    'mypunctoo',
    $6,
    $7::inet,
    $8,
    $9,
    $10,
    $11
  )
  RETURNING
    scan_event_id,
    client_id,
    scantag_id,
    employee_id,
    direction,
    scanned_at,
    source,
    anomaly_code,
    measurement_valid,
    is_system,
    created_at;
`;

// -----------------------------
// POST scan-event with business rules v1
// POST /api/mypunctoo/employees/:employee_id/scan-events?email=...
// body: { "direction": "IN" | "OUT" }
// -----------------------------
router.post("/employees/:employee_id/scan-events", async (req, res) => {
  const email = req.query.email;
  const { employee_id } = req.params;
  const directionRaw = (req.body?.direction || "").toString().trim().toUpperCase();

  if (!directionRaw) return res.status(400).json({ ok: false, error: "direction is required" });
  if (directionRaw !== "IN" && directionRaw !== "OUT") {
    return res.status(400).json({ ok: false, error: "direction must be IN or OUT" });
  }

  const userAgent = req.headers["user-agent"] || null;
  const ip = normalizeIp(req) || null;

  const dbClient = await pool.connect();
  const now = new Date();

  try {
    // 1) Context gating (uses pool internally; ok)
    const ctx = await getMypunctooContext(email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    // 2) Transaction start
    await dbClient.query("BEGIN");

    // 3) Ownership inside tx
    const own = await requireEmployeeBelongsToClient(employee_id, ctx.client.client_id, dbClient);
    if (!own.ok) {
      await dbClient.query("ROLLBACK");
      return res.status(own.status).json(own.body);
    }

    // 4) Fetch last event (FOR UPDATE)
    const lastR = await dbClient.query(SQL_LAST_EVENT_FOR_UPDATE, [employee_id]);
    const last = lastR.rowCount ? lastR.rows[0] : null;

    const status_before = last ? deriveStatusAfterFromLatestEventRow(last) : null;

    // 5) Double-tap ignore (10s) — ignore any scan within 10 seconds of last scan_event
    if (last) {
      const lastAt = new Date(last.scanned_at);
      const deltaSec = diffSeconds(now, lastAt);
      if (deltaSec >= 0 && deltaSec < DOUBLE_TAP_WINDOW_SECONDS) {
        await dbClient.query("ROLLBACK");
        return res.status(200).json({
          ok: true,
          accepted: false,
          ignored: true,
          reason: "DUPLICATE_WITHIN_COOLDOWN",
          cooldown_seconds: DOUBLE_TAP_WINDOW_SECONDS,
          status_before,
          status_after: status_before,
          server_time: now.toISOString(),
        });
      }
    }

    // Helper for inserts
    async function insertEvent({
      direction,
      scannedAt,
      anomalyCode = null,
      measurementValid = true,
      isSystem = false,
    }) {
      const createdAt = scannedAt; // keep created_at aligned with scanned_at
      const r = await dbClient.query(SQL_INSERT_EVENT, [
        ctx.client.client_id,
        ctx.scantag.scantag_id,
        employee_id,
        direction,
        scannedAt,
        userAgent,
        ip,
        anomalyCode,
        measurementValid,
        isSystem,
        createdAt,
      ]);
      return r.rows[0];
    }

    // 6) Decision tree
    if (directionRaw === "IN") {
      // IN-1: first scan ever
      if (!last) {
        const event = await insertEvent({
          direction: "IN",
          scannedAt: now,
          anomalyCode: null,
          measurementValid: true,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "IN",
          warning: null,
          event,
          server_time: now.toISOString(),
        });
      }

      // IN-2: last OUT => cooldown check (60m)
      if (last.direction === "OUT") {
        const lastAt = new Date(last.scanned_at);
        const deltaSec = diffSeconds(now, lastAt);
        const cooldownSec = COOLDOWN_AFTER_OUT_MINUTES * 60;

        if (deltaSec >= 0 && deltaSec < cooldownSec) {
          const retryAfter = cooldownSec - deltaSec;

          await dbClient.query("ROLLBACK");
          return res.status(409).json({
            ok: true,
            accepted: false,
            ignored: false,
            reason: "COOLDOWN_AFTER_OUT",
            retry_after_seconds: retryAfter,
            status_before,
            status_after: status_before,
            server_time: now.toISOString(),
          });
        }

        // allowed normal IN
        const event = await insertEvent({
          direction: "IN",
          scannedAt: now,
          anomalyCode: null,
          measurementValid: true,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "IN",
          warning: null,
          event,
          server_time: now.toISOString(),
        });
      }

      // IN-3: last IN => AUTO-FIX (system OUT now, then IN now+1ms)
      if (last.direction === "IN") {
        const outAt = now;
        const inAt = addMs(now, 1);

        const systemOut = await insertEvent({
          direction: "OUT",
          scannedAt: outAt,
          anomalyCode: "AUTO_CLOSED_PREVIOUS_IN",
          measurementValid: false,
          isSystem: true,
        });

        const event = await insertEvent({
          direction: "IN",
          scannedAt: inAt,
          anomalyCode: "IN_AFTER_IN",
          measurementValid: false,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "IN",
          warning: "IN_AFTER_IN_AUTO_CLOSED",
          event,
          extra_events: [systemOut],
          server_time: now.toISOString(),
        });
      }
    }

    if (directionRaw === "OUT") {
      // OUT-1: first scan is OUT => allow but treated-as IN (invalid measurement)
      if (!last) {
        const event = await insertEvent({
          direction: "OUT",
          scannedAt: now,
          anomalyCode: "OUT_WITHOUT_IN",
          measurementValid: false,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "IN", // treated-as start
          warning: "OUT_TREATED_AS_IN_NO_MEASUREMENT",
          event,
          server_time: now.toISOString(),
        });
      }

      // OUT-2: last IN => normal OUT valid
      if (last.direction === "IN") {
        const event = await insertEvent({
          direction: "OUT",
          scannedAt: now,
          anomalyCode: null,
          measurementValid: true,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "OUT",
          warning: null,
          event,
          server_time: now.toISOString(),
        });
      }

      // OUT-3: last OUT => allow + flag invalid
      if (last.direction === "OUT") {
        const event = await insertEvent({
          direction: "OUT",
          scannedAt: now,
          anomalyCode: "OUT_AFTER_OUT",
          measurementValid: false,
          isSystem: false,
        });

        await dbClient.query("COMMIT");
        return res.status(201).json({
          ok: true,
          accepted: true,
          ignored: false,
          status_before,
          status_after: "OUT",
          warning: "OUT_AFTER_OUT_IGNORED_FOR_MEASUREMENT",
          event,
          server_time: now.toISOString(),
        });
      }
    }

    // Should never happen
    await dbClient.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: "UNEXPECTED_STATE" });
  } catch (err) {
    try {
      await dbClient.query("ROLLBACK");
    } catch (_) {}
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    dbClient.release();
  }
});

// -----------------------------
// GET scan-events history
// GET /api/mypunctoo/employees/:employee_id/scan-events?email=...&limit=50
// -----------------------------
router.get("/employees/:employee_id/scan-events", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;

    const limitRaw = (req.query.limit || "50").toString();
    let limit = parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    const own = await requireEmployeeBelongsToClient(employee_id, ctx.client.client_id);
    if (!own.ok) return res.status(own.status).json(own.body);

    const q = `
      SELECT
        scan_event_id,
        direction,
        scanned_at,
        source,
        anomaly_code,
        measurement_valid,
        is_system,
        created_at
      FROM public.scan_event
      WHERE client_id = $1 AND employee_id = $2
      ORDER BY scanned_at DESC, created_at DESC, scan_event_id DESC
      LIMIT $3
    `;
    const r = await pool.query(q, [ctx.client.client_id, employee_id, limit]);

    const events = r.rows;

    // current_status uses treated-as for OUT_WITHOUT_IN
    const current_status = events.length ? deriveStatusAfterFromLatestEventRow(events[0]) : null;

    return res.json({ ok: true, employee_id, current_status, events });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
