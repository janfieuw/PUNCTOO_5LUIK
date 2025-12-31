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

  // Haal dezelfde performances-data als de JSON endpoint
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

  // Flatten: 1 rij per performance
  for (const emp of data.employees || []) {
    const name = emp.display_name || `${emp.first_name || ""} ${emp.last_name || ""}`.trim();

    for (const p of emp.performances || []) {
      const started = p.started_at ? new Date(p.started_at) : null;
      const ended = p.ended_at ? new Date(p.ended_at) : null;

      const isOpen = !!p.started_at && !p.ended_at;

      // attention_flags: feitelijk, geen oordeel
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

module.exports = {
  exportEffectiveAttendanceXlsx,
};
