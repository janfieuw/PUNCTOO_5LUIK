const express = require("express");
const { getPerformancesData } = require("../services/mypunctooPerformances.service");

const router = express.Router();

/**
 * GET /api/mypunctoo/performances?email=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Read-only, feitelijk.
 */
router.get("/performances", async (req, res) => {
  try {
    const data = await getPerformancesData({
      email: req.query.email,
      from: req.query.from,
      to: req.query.to,
      employee_id: req.query.employee_id || null,
    });

    if (!data.ok && data.status) {
      return res.status(data.status).json(data.body);
    }

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
