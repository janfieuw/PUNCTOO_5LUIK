const ExcelJS = require("exceljs");
const { getPerformances } = require("../services/mypunctooPerformances.service");


async function exportEffectiveAttendanceXlsx(req, res) {
  const { from, to, employee_id } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  }

  const performances = await getPerformances({
    clientId: req.user.client_id,
    from,
    to,
    employeeId: employee_id || null,
  });

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

  for (const p of performances) {
    ws.addRow({
      employee_id: p.employee_id,
      employee_name: p.employee_name || "",
      date_in: p.scan_in_at ? formatDate(p.scan_in_at) : "",
      time_in: p.scan_in_at ? formatTime(p.scan_in_at) : "",
      date_out: p.scan_out_at ? formatDate(p.scan_out_at) : "",
      time_out: p.scan_out_at ? formatTime(p.scan_out_at) : "",
      duration_minutes:
        p.scan_in_at && p.scan_out_at ? p.effective_minutes : "",
      is_open_shift: !!p.is_open_shift,
      attention_flags: Array.isArray(p.attention_flags)
        ? p.attention_flags.join(",")
        : p.attention_flags || "",
    });
  }

  const fileName = `punctoo_effective_attendance_${from}_${to}.xlsx`;

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`
  );

  await wb.xlsx.write(res);
  res.end();
}

function formatDate(d) {
  const x = new Date(d);
  return x.toISOString().slice(0, 10);
}

function formatTime(d) {
  const x = new Date(d);
  return x.toISOString().slice(11, 19);
}

module.exports = {
  exportEffectiveAttendanceXlsx,
};
