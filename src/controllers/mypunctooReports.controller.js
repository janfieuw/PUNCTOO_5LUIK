const ExcelJS = require("exceljs");
const { getPerformancesData } = require("../services/mypunctooPerformances.service");

function formatDate(d) {
  const x = new Date(d);
  return x.toISOString().slice(0, 10);
}

function formatTime(d) {
  const x = new Date(d);
  return x.toISOString().slice(11, 19);
}

/**
 * Rapport 1 — Effectieve aanwezigheid (XLS)
 * URL: /api/mypunctoo/reports/effective-attendance.xlsx?email=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 */
async function exportEffectiveAttendanceXlsx(req, res) {
  const { email, from, to, employee_id } = req.query;

  if (!email) return res.status(400).json({ ok: false, error: "email query param is required" });
  if (!from || !to) return res.status(400).json({ ok: false, error: "from and to are required (YYYY-MM-DD)" });

  const data = await getPerformancesData({ email, from, to, employee_id: employee_id || null });

  if (!data.ok && data.status) {
    return res.status(data.status).json(data.body);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "PUNCTOO";
  wb.created = new Date();

  const ws = wb.addWorksheet("Effectieve aanwezigheid", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "employee_id", key: "employee_id", width: 18 },
    { header: "employee_name", key: "employee_name", width: 28 },
    { header: "date_in", key: "date_in", width: 12 },
    { header: "time_in", key: "time_in", width: 12 },
    { header: "date_out", key: "date_out", width: 12 },
    { header: "time_out", key: "time_out", width: 12 },
    { header: "duration_minutes", key: "duration_minutes", width: 16 },
    { header: "is_open_shift", key: "is_open_shift", width: 14 },
    { header: "attention_flags", key: "attention_flags", width: 40 },
  ];

  ws.getRow(1).font = { bold: true };

  for (const emp of data.employees || []) {
    const name = emp.display_name || `${emp.first_name || ""} ${emp.last_name || ""}`.trim();

    for (const p of emp.performances || []) {
      const started = p.started_at ? new Date(p.started_at) : null;
      const ended = p.ended_at ? new Date(p.ended_at) : null;

      const isOpen = !!p.started_at && !p.ended_at;
      const flags = Array.isArray(p.attention_reasons) ? p.attention_reasons.join(",") : "";

      ws.addRow({
        employee_id: emp.employee_id,
        employee_name: name,

        date_in: started ? formatDate(started) : "",
        time_in: started ? formatTime(started) : "",

        date_out: ended ? formatDate(ended) : "",
        time_out: ended ? formatTime(ended) : "",

        duration_minutes: Number.isFinite(p.effective_minutes) ? p.effective_minutes : "",
        is_open_shift: isOpen ? "TRUE" : "FALSE",
        attention_flags: flags,
      });
    }
  }

  const fileName = `punctoo_effective_attendance_${from}_${to}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  await wb.xlsx.write(res);
  res.end();
}

/**
 * Rapport 2 — Over-time (XLS)
 * Definitie: Over-time is het positieve tijdverschil tussen de referentieduur
 * (inclusief pauzes) en de effectieve aanwezigheid.
 *
 * URL: /api/mypunctoo/reports/overtime.xlsx?email=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Regels:
 * - Alleen werknemers met referentieduur_minutes != null
 * - Alleen measurable prestaties met IN+OUT
 * - Alleen overtime_minutes > 0 (geen under-time)
 */
async function exportOvertimeXlsx(req, res) {
  const { email, from, to, employee_id } = req.query;

  if (!email) return res.status(400).json({ ok: false, error: "email query param is required" });
  if (!from || !to) return res.status(400).json({ ok: false, error: "from and to are required (YYYY-MM-DD)" });

  const data = await getPerformancesData({ email, from, to, employee_id: employee_id || null });

  if (!data.ok && data.status) {
    return res.status(data.status).json(data.body);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "PUNCTOO";
  wb.created = new Date();

  const ws = wb.addWorksheet("Over-time", {
    views: [{ state: "frozen", ySplit: 2 }],
  });

  // Rij 1: definitie (informatief)
  ws.getCell("A1").value =
    "Over-time is het positieve tijdverschil tussen de referentieduur van een aanwezigheidsprestatie (inclusief pauzes) en de effectieve aanwezigheid.";
  ws.mergeCells("A1", "I1");
  ws.getRow(1).font = { italic: true };
  ws.getRow(1).alignment = { vertical: "middle", wrapText: true };
  ws.getRow(1).height = 30;

ws.columns = [
  { key: "employee_id", width: 18 },
  { key: "employee_name", width: 28 },
  { key: "date_in", width: 12 },
  { key: "time_in", width: 12 },
  { key: "date_out", width: 12 },
  { key: "time_out", width: 12 },
  { key: "effective_minutes", width: 16 },
  { key: "reference_minutes", width: 18 },
  { key: "overtime_minutes", width: 16 },
];

// EXPliciete header-rij op rij 2
ws.getRow(2).values = [
  "employee_id",
  "employee_name",
  "date_in",
  "time_in",
  "date_out",
  "time_out",
  "effective_minutes",
  "reference_minutes",
  "overtime_minutes",
];
ws.getRow(2).font = { bold: true };


  // Data vanaf rij 3
  for (const emp of data.employees || []) {
    // Alleen werknemers met referentieduur
    if (!Number.isFinite(emp.referentieduur_minutes)) continue;

    const name =
      emp.display_name ||
      `${(emp.first_name || "").trim()} ${(emp.last_name || "").trim()}`.trim();

    for (const p of emp.performances || []) {
      // Alleen meetbaar + compleet + overtime > 0
      if (p.measurable !== true) continue;
      if (!p.started_at || !p.ended_at) continue;
      if (!Number.isFinite(p.overtime_minutes) || p.overtime_minutes <= 0) continue;

      const started = new Date(p.started_at);
      const ended = new Date(p.ended_at);

      ws.addRow({
        employee_id: emp.employee_id,
        employee_name: name,
        date_in: formatDate(started),
        time_in: formatTime(started),
        date_out: formatDate(ended),
        time_out: formatTime(ended),
        effective_minutes: p.effective_minutes,
        reference_minutes: p.reference_minutes,
        overtime_minutes: p.overtime_minutes,
      });
    }
  }

  const fileName = `punctoo_overtime_${from}_${to}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  await wb.xlsx.write(res);
  res.end();
}

module.exports = {
  exportEffectiveAttendanceXlsx,
  exportOvertimeXlsx,
};
