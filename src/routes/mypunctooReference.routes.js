const express = require("express");
const { pool } = require("../db");
const { getMypunctooContext } = require("../services/mypunctooPerformances.service");

const router = express.Router();

/**
 * Helper: validate minutes
 * - null toegestaan (blanco)
 * - integer 1..1440 (max 24u) als je iets instelt
 */
function parseReferentieMinutes(input) {
  if (input === null) return { ok: true, value: null };
  if (input === undefined) return { ok: false, error: "referentieduur_minutes is required (number or null)" };

  const n = Number(input);
  if (!Number.isFinite(n)) return { ok: false, error: "referentieduur_minutes must be a number or null" };

  const i = Math.trunc(n);
  if (i !== n) return { ok: false, error: "referentieduur_minutes must be an integer" };

  if (i < 1 || i > 1440) return { ok: false, error: "referentieduur_minutes must be between 1 and 1440, or null" };

  return { ok: true, value: i };
}

/**
 * GET /api/mypunctoo/employees/:employee_id/reference?email=...
 * Read-only: toont huidige referentieduur (kan null)
 */
router.get("/employees/:employee_id/reference", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const clientId = ctx.client.client_id;
    const { employee_id } = req.params;

    const q = `
      SELECT employee_id, referentieduur_minutes
      FROM employee
      WHERE employee_id = $1 AND client_id = $2
      LIMIT 1
    `;
    const r = await pool.query(q, [employee_id, clientId]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "employee not found" });

    return res.json({
      ok: true,
      employee_id: r.rows[0].employee_id,
      referentieduur_minutes: r.rows[0].referentieduur_minutes,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/mypunctoo/employees/:employee_id/reference?email=...
 * Body: { "referentieduur_minutes": 480 } of { "referentieduur_minutes": null }
 *
 * - Geen defaults
 * - Geen suggesties
 * - Expliciete HR input
 */
router.put("/employees/:employee_id/reference", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const clientId = ctx.client.client_id;
    const { employee_id } = req.params;

    const parsed = parseReferentieMinutes(req.body ? req.body.referentieduur_minutes : undefined);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

    const q = `
      UPDATE employee
      SET referentieduur_minutes = $3,
          updated_at = NOW()
      WHERE employee_id = $1 AND client_id = $2
      RETURNING employee_id, referentieduur_minutes, updated_at
    `;
    const r = await pool.query(q, [employee_id, clientId, parsed.value]);

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "employee not found" });

    return res.json({
      ok: true,
      employee_id: r.rows[0].employee_id,
      referentieduur_minutes: r.rows[0].referentieduur_minutes,
      updated_at: r.rows[0].updated_at,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
