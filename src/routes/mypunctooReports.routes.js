const express = require("express");
const { exportEffectiveAttendanceXlsx } = require("../controllers/mypunctooReports.controller");

const router = express.Router();

router.get("/reports/effective-attendance.xlsx", exportEffectiveAttendanceXlsx);

module.exports = router;
