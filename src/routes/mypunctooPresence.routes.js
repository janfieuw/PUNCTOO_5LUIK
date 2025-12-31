const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// -----------------------------
// helpers (zelfde stijl als scan-events file)
// -----------------------------
function deriveStatusAfterFromLatestEventRow(row) {
  // Treat OUT_WITHOUT_IN as "IN" for status purposes (as agreed)
  if (!row) return null;
  if (row.anomaly_code === "OUT_WITHOUT_IN") return "IN";
  return row.direction;
}

function toLowerEmail(emailRaw) {
  return (emailRaw || "").toString().trim().toLowerCase();
}

// -----------------------------
// Context helpers (kopie uit jouw scan-events file)
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

// -----------------------------
// GET presence dashboard
// GET /api/mypunctoo/presence?email=...
// -----------------------------
router.get("/presence", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const clientId = ctx.client.client_id;

    // Presence list
    const listSql = `
      WITH last_event AS (
        SELECT
          e.employee_id,
          se.scan_event_id,
          se.scanned_at,
          se.direction,
          se.anomaly_code,
          se.measurement_valid,
          se.is_system,
          se.created_at
        FROM employee e
        LEFT JOIN LATERAL (
          SELECT
            se1.scan_event_id,
            se1.scanned_at,
            se1.direction,
            se1.anomaly_code,
            se1.measurement_valid,
            se1.is_system,
            se1.created_at
          FROM public.scan_event se1
          WHERE se1.employee_id = e.employee_id
          ORDER BY se1.scanned_at DESC, se1.created_at DESC, se1.scan_event_id DESC
          LIMIT 1
        ) se ON TRUE
        WHERE e.client_id = $1
      )
      SELECT
        e.employee_id,
        e.first_name,
        e.last_name,
        e.email,
        e.created_at AS employee_created_at,
        e.updated_at AS employee_updated_at,

        le.scan_event_id AS last_scan_event_id,
        le.direction AS last_direction,
        le.scanned_at AS since,
        COALESCE(le.measurement_valid, true) AS measurement_valid,
        le.anomaly_code,
        COALESCE(le.is_system, false) AS is_system,

        CASE
          WHEN le.scan_event_id IS NULL THEN 'UNKNOWN'
          WHEN le.direction = 'IN' THEN 'IN'
          WHEN le.direction = 'OUT' AND le.anomaly_code = 'OUT_WITHOUT_IN' THEN 'IN'
          ELSE 'OUT'
        END AS current_status
      FROM employee e
      LEFT JOIN last_event le ON le.employee_id = e.employee_id
      WHERE e.client_id = $1
      ORDER BY
        CASE
          WHEN le.scan_event_id IS NULL THEN 2
          WHEN (le.direction = 'IN') THEN 0
          WHEN (le.direction = 'OUT' AND le.anomaly_code = 'OUT_WITHOUT_IN') THEN 0
          ELSE 1
        END,
        e.created_at DESC;
    `;

    // Summary
    const summarySql = `
      WITH presence AS (
        SELECT
          e.employee_id,
          CASE
            WHEN se.scan_event_id IS NULL THEN 'UNKNOWN'
            WHEN se.direction = 'IN' THEN 'IN'
            WHEN se.direction = 'OUT' AND se.anomaly_code = 'OUT_WITHOUT_IN' THEN 'IN'
            ELSE 'OUT'
          END AS current_status,
          COALESCE(se.measurement_valid, true) AS measurement_valid,
          se.anomaly_code
        FROM employee e
        LEFT JOIN LATERAL (
          SELECT
            se1.scan_event_id,
            se1.direction,
            se1.anomaly_code,
            se1.measurement_valid,
            se1.scanned_at,
            se1.created_at
          FROM public.scan_event se1
          WHERE se1.employee_id = e.employee_id
          ORDER BY se1.scanned_at DESC, se1.created_at DESC, se1.scan_event_id DESC
          LIMIT 1
        ) se ON TRUE
        WHERE e.client_id = $1
      )
      SELECT
        SUM(CASE WHEN current_status = 'IN' THEN 1 ELSE 0 END)::int AS "in",
        SUM(CASE WHEN current_status = 'OUT' THEN 1 ELSE 0 END)::int AS "out",
        SUM(CASE WHEN current_status = 'UNKNOWN' THEN 1 ELSE 0 END)::int AS "no_scans",
        SUM(CASE WHEN (measurement_valid = false OR anomaly_code IS NOT NULL) THEN 1 ELSE 0 END)::int AS attention
      FROM presence;
    `;

    const [listR, summaryR] = await Promise.all([
      pool.query(listSql, [clientId]),
      pool.query(summarySql, [clientId]),
    ]);

    const summary = summaryR.rows[0] || { in: 0, out: 0, no_scans: 0, attention: 0 };

    // Extra: maak een "display_name" in JS (handig voor UI)
    const employees = (listR.rows || []).map((r) => ({
      ...r,
      display_name: `${(r.first_name || "").trim()} ${(r.last_name || "").trim()}`.trim(),
      // Als je ooit status wil afleiden zoals scan-events endpoint doet:
      // derived_status: r.last_scan_event_id ? deriveStatusAfterFromLatestEventRow(r) : null,
    }));

    return res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      summary,
      employees,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
