const express = require("express");
const { pool } = require("./db");

const app = express();
app.use(express.json());

// health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "PUNCTOO_5LUIK" });
});

// DB check
app.get("/db-check", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: "connected", now: r.rows[0].now });
  } catch (err) {
    res.status(500).json({
      ok: false,
      db: "error",
      message: err.message,
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
