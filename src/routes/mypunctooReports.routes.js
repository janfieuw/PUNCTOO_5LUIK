import express from "express";
import { exportEffectiveAttendanceXlsx } from "../controllers/mypunctooReports.controller.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

// Rapport 1 — Effectieve aanwezigheid (XLS)
router.get(
  "/reports/effective-attendance.xlsx",
  requireAuth,
  exportEffectiveAttendanceXlsx
);

export default router;
