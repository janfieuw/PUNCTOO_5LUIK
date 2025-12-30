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
// --- helpers ---
function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// --- create customer order (signup as order) ---
app.post("/api/orders", async (req, res) => {
  const {
    company_name,
    vat_number,
    contact_name,
    email,
    phone,
    street,
    house_number,
    box,
    postal_code,
    city,
  } = req.body || {};

  // minimal validation
  if (!company_name || typeof company_name !== "string") {
    return res.status(400).json({ ok: false, error: "company_name is required" });
  }
  if (!contact_name || typeof contact_name !== "string") {
    return res.status(400).json({ ok: false, error: "contact_name is required" });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ ok: false, error: "valid email is required" });
  }

  // CUSTOMER must have vat_number (your rule: DEMO has none; CUSTOMER does)
  if (!vat_number || typeof vat_number !== "string") {
    return res.status(400).json({ ok: false, error: "vat_number is required for CUSTOMER" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert CUSTOMER client by (client_type,email) to prevent duplicates on retry
    // If same customer re-orders, we keep client record and just create a new order.
    const upsertClientSql = `
      INSERT INTO client (
        client_type, company_name, vat_number,
        contact_name, email, phone,
        street, house_number, box, postal_code, city,
        mypunctoo_enabled
      )
      VALUES (
        'CUSTOMER', $1, $2,
        $3, $4, $5,
        $6, $7, $8, $9, $10,
        FALSE
      )
      ON CONFLICT (client_type, email) DO UPDATE
      SET company_name = EXCLUDED.company_name,
          vat_number = EXCLUDED.vat_number,
          contact_name = EXCLUDED.contact_name,
          phone = EXCLUDED.phone,
          street = EXCLUDED.street,
          house_number = EXCLUDED.house_number,
          box = EXCLUDED.box,
          postal_code = EXCLUDED.postal_code,
          city = EXCLUDED.city,
          updated_at = NOW()
      RETURNING client_id, mypunctoo_enabled;
    `;

    const clientRow = await client.query(upsertClientSql, [
      company_name.trim(),
      vat_number.trim(),
      contact_name.trim(),
      email.trim().toLowerCase(),
      phone || null,
      street || null,
      house_number || null,
      box || null,
      postal_code || null,
      city || null,
    ]);

    const clientId = clientRow.rows[0].client_id;

    // Create NEW order (includes 1 ScanTag later when processed by admin)
    const orderSql = `
      INSERT INTO subscription_order (client_id, status, admin_note)
      VALUES ($1, 'NEW', 'Customer signup (includes 1 ScanTag)')
      RETURNING order_id, status, created_at;
    `;
    const orderRow = await client.query(orderSql, [clientId]);

    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      client_id: clientId,
      order: orderRow.rows[0],
      message: "Order created. Awaiting admin processing to enable MyPunctoo and assign ScanTag.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// --- order status ---
app.get("/api/orders/:order_id", async (req, res) => {
  const { order_id } = req.params;

  try {
    const q = `
      SELECT
        o.order_id,
        o.status,
        o.created_at,
        o.processed_at,
        o.ready_to_invoice,
        o.ready_to_invoice_at,
        c.client_id,
        c.company_name,
        c.email,
        c.mypunctoo_enabled,
        c.mypunctoo_enabled_at
      FROM subscription_order o
      JOIN client c ON c.client_id = o.client_id
      WHERE o.order_id = $1
      LIMIT 1;
    `;
    const r = await pool.query(q, [order_id]);

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    return res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
