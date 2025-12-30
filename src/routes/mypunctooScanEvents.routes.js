const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// helpers (lokaal, zodat deze file zelfstandig werkt)
function normalizeIp(req) {
  const raw = req.ip || "";
  return raw.startsWith("::ffff:") ? raw.replace("::ffff:", "") : raw;
}

async function getEnabledCustomerByEmail(emailRaw) {
  const email = (emailRaw || "").toString().trim().toLowerCase();
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

async function requireEmployeeBelongsToClient(employee_id, client_id) {
  const q = `
    SELECT employee_id
    FROM employee
    WHERE employee_id = $1 AND client_id = $2
    LIMIT 1
  `;
  const r = await pool.query(q, [employee_id, client_id]);
  if (r.rowCount === 0) {
    return { ok: false, status: 404, body: { ok: false, error: "employee not found" } };
  }
  return { ok: true };
}

/**
 * POST /api/mypunctoo/employees/:employee_id/scan-events?email=...
 * body: { "direction": "IN" | "OUT" }
 */
router.post("/employees/:employee_id/scan-events", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;
    const { direction } = req.body || {};

    if (!direction) return res.status(400).json({ ok: false, error: "direction is required" });
    if (direction !== "IN" && direction !== "OUT") {
      return res.status(400).json({ ok: false, error: "direction must be IN or OUT" });
    }

    const own = await requireEmployeeBelongsToClient(employee_id, ctx.client.client_id);
    if (!own.ok) return res.status(own.status).json(own.body);

    const q = `
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
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4::public.scan_direction,
        NOW(),
        'mypunctoo',
        $5,
        $6::inet,
        NOW()
      )
      RETURNING
        scan_event_id,
        client_id,
        scantag_id,
        employee_id,
        direction,
        scanned_at,
        source,
        created_at;
    `;

    const userAgent = req.headers["user-agent"] || null;
    const ip = normalizeIp(req) || null;

    const r = await pool.query(q, [
      ctx.client.client_id,
      ctx.scantag.scantag_id,
      employee_id,
      direction,
      userAgent,
      ip,
    ]);

    return res.status(201).json({ ok: true, event: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/mypunctoo/employees/:employee_id/scan-events?email=...&limit=50
 */
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
        created_at
      FROM public.scan_event
      WHERE client_id = $1 AND employee_id = $2
      ORDER BY scanned_at DESC, created_at DESC
      LIMIT $3
    `;
    const r = await pool.query(q, [ctx.client.client_id, employee_id, limit]);

    const events = r.rows;
    const current_status = events.length ? events[0].direction : null;

    return res.json({ ok: true, employee_id, current_status, events });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
