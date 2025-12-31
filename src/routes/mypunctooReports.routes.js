const express = require("express");
const {
  exportEffectiveAttendanceXlsx,
  exportOvertimeXlsx,
  exportPeriodTotalsXlsx,
} = require("../controllers/mypunctooReports.controller");

const router = express.Router();

/**
 * Rapport 1 — Effectieve aanwezigheid (XLS)
 * GET /api/mypunctoo/reports/effective-attendance.xlsx
 */
router.get(
  "/reports/effective-attendance.xlsx",
  exportEffectiveAttendanceXlsx
);

/**
 * Rapport 2 — Over-time (XLS)
 * GET /api/mypunctoo/reports/overtime.xlsx
 */
router.get(
  "/reports/overtime.xlsx",
  exportOvertimeXlsx
);

/**
 * Rapport 3 — Periode-totalen (XLS)
 * GET /api/mypunctoo/reports/period-totals.xlsx
 */
router.get(
  "/reports/period-totals.xlsx",
  exportPeriodTotalsXlsx
);

module.exports = router;
