const express = require("express");
const {
  exportEffectiveAttendanceXlsx,
  exportOvertimeXlsx,
} = require("../controllers/mypunctooReports.controller");

const router = express.Router();

// Rapport 1
router.get("/reports/effective-attendance.xlsx", exportEffectiveAttendanceXlsx);

// Rapport 2
router.get("/reports/overtime.xlsx", exportOvertimeXlsx);

module.exports = router;
