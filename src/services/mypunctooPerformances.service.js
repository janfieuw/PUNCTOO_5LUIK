const { pool } = require("../db");

/**
 * Haalt aanwezigheidsprestaties op voor MyPunctoo.
 * Single source of truth: deze functie wordt gebruikt door:
 * - GET /api/mypunctoo/performances
 * - XLS export (effectieve aanwezigheid)
 */
async function getPerformances({ clientId, from, to, employeeId = null }) {
  // Hard fail: geen defaults
  if (!clientId) throw new Error("clientId is required");
  if (!from || !to) throw new Error("from and to are required");

  // TODO: VERVANG dit door exact jouw bestaande SQL uit mypunctooPerformances.routes.js
  // Ik zet hier bewust een placeholder zodat jij niets “magisch” krijgt.
  const q = `
    SELECT 1
  `;
  const r = await pool.query(q, []);
  return r.rows;
}

module.exports = { getPerformances };
