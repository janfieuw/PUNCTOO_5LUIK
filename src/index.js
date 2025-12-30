const express = require("express");
const { pool } = require("./db");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// Als Railway/Proxy: uncomment indien je correcte req.ip wil
// app.set("trust proxy", 1);

// -------------------- helpers --------------------
function isEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function normalizeIp(req) {
  const raw = req.ip || "";
  return raw.startsWith("::ffff:") ? raw.replace("::ffff:", "") : raw;
}

/**
 * Basis: klant vinden op email, enkel CUSTOMER.
 * Let op: deze functie checkt enkel CUSTOMER + mypunctoo_enabled.
 * Active scantag check zit in getMypunctooContext().
 */
async function getEnabledCustomerByEmail(emailRaw) {
  const email = (emailRaw || "").toString().trim().toLowerCase();
  if (!email) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "email query param is required" },
    };
  }

  const cQ = `
    SELECT client_id, client_type, company_name, email, mypunctoo_enabled, mypunctoo_enabled_at
    FROM client
    WHERE client_type = 'CUSTOMER' AND email = $1
    LIMIT 1
  `;
  const cR = await pool.query(cQ, [email]);

  if (cR.rowCount === 0) {
    return {
      ok: false,
      status: 404,
      body: { ok: true, allowed: false, reason: "NO_CUSTOMER_ACCOUNT" },
    };
  }

  const client = cR.rows[0];

  if (!client.mypunctoo_enabled) {
    return {
      ok: false,
      status: 200,
      body: { ok: true, allowed: false, reason: "NOT_ENABLED_YET", client_id: client.client_id },
    };
  }

  return { ok: true, client };
}

/**
 * MyPunctoo context = enabled customer + minstens 1 ACTIVE scantag
 * Dit gebruiken we voor employees én scan-events.
 */
async function getMypunctooContext(emailRaw) {
  const g = await getEnabledCustomerByEmail(emailRaw);
  if (!g.ok) return g;

  const client = g.client;

  const sQ = `
    SELECT scantag_id, qr_url_in, qr_url_out, status, created_at
    FROM scantag
    WHERE client_id = $1 AND status = 'ACTIVE'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const sR = await pool.query(sQ, [client.client_id]);

  if (sR.rowCount === 0) {
    return {
      ok: false,
      status: 200,
      body: { ok: true, allowed: false, reason: "NO_ACTIVE_SCANTAG", client_id: client.client_id },
    };
  }

  return { ok: true, client, scantag: sR.rows[0] };
}

async function requireEmployeeBelongsToClient(employee_id, client_id) {
  const q = `
    SELECT employee_id
    FROM employee
    WHERE employee_id = $1 AND client_id = $2
    LIMIT 1
  `;
  const r = await pool.query(q, [employee_id, client_id]);
  if (r.rowCount === 0) {
    return { ok: false, status: 404, body: { ok: false, error: "employee not found" } };
  }
  return { ok: true };
}

// -------------------- health --------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "PUNCTOO_5LUIK" });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "PUNCTOO_5LUIK" });
});

app.get("/db-check", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: "connected", now: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, db: "error", message: err.message });
  }
});

app.get("/api/db-check", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: "connected", now: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, db: "error", message: err.message });
  }
});

// -------------------- orders (customer signup as order) --------------------
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

  if (!company_name || typeof company_name !== "string") {
    return res.status(400).json({ ok: false, error: "company_name is required" });
  }
  if (!contact_name || typeof contact_name !== "string") {
    return res.status(400).json({ ok: false, error: "contact_name is required" });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ ok: false, error: "valid email is required" });
  }
  if (!vat_number || typeof vat_number !== "string") {
    return res.status(400).json({ ok: false, error: "vat_number is required for CUSTOMER" });
  }

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");

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

    const clientRow = await cx.query(upsertClientSql, [
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

    const orderSql = `
      INSERT INTO subscription_order (client_id, status, admin_note)
      VALUES ($1, 'NEW', 'Customer signup (includes 1 ScanTag)')
      RETURNING order_id, status, created_at;
    `;
    const orderRow = await cx.query(orderSql, [clientId]);

    await cx.query("COMMIT");
    return res.status(201).json({
      ok: true,
      client_id: clientId,
      order: orderRow.rows[0],
      message: "Order created. Awaiting admin processing to enable MyPunctoo and assign ScanTag.",
    });
  } catch (err) {
    await cx.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    cx.release();
  }
});

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
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "order not found" });
    return res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------- admin: process order --------------------
// TODO later: protect with ADMIN_LOGIN / ADMIN_PASSWORD_HASH from env/config
app.post("/api/admin/orders/:order_id/process", async (req, res) => {
  const { order_id } = req.params;
  const cx = await pool.connect();

  try {
    await cx.query("BEGIN");

    const orderQ = `
      SELECT o.order_id, o.status, o.client_id
      FROM subscription_order o
      WHERE o.order_id = $1
      FOR UPDATE
    `;
    const orderR = await cx.query(orderQ, [order_id]);
    if (orderR.rowCount === 0) {
      await cx.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    const order = orderR.rows[0];
    if (order.status !== "NEW") {
      await cx.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: `order not processable (status=${order.status})` });
    }

    const clientId = order.client_id;

    const insertScanTagQ = `
      INSERT INTO scantag (client_id, qr_url_in, qr_url_out, status)
      VALUES ($1, $2, $3, 'ACTIVE')
      RETURNING scantag_id, qr_url_in, qr_url_out, status, created_at;
    `;

    const qrIn = `https://scan.punctoo.be/in/${crypto.randomUUID()}`;
    const qrOut = `https://scan.punctoo.be/out/${crypto.randomUUID()}`;
    const stR = await cx.query(insertScanTagQ, [clientId, qrIn, qrOut]);
    const scantag = stR.rows[0];

    const enableClientQ = `
      UPDATE client
      SET mypunctoo_enabled = TRUE,
          mypunctoo_enabled_at = NOW(),
          updated_at = NOW()
      WHERE client_id = $1
      RETURNING client_id, mypunctoo_enabled, mypunctoo_enabled_at;
    `;
    const clientR = await cx.query(enableClientQ, [clientId]);

    const updOrderQ = `
      UPDATE subscription_order
      SET status = 'PROCESSED',
          processed_at = NOW(),
          ready_to_invoice = TRUE,
          ready_to_invoice_at = NOW(),
          updated_at = NOW()
      WHERE order_id = $1
      RETURNING order_id, status, processed_at, ready_to_invoice, ready_to_invoice_at;
    `;
    const updOrderR = await cx.query(updOrderQ, [order_id]);

    await cx.query("COMMIT");
    return res.json({
      ok: true,
      order: updOrderR.rows[0],
      client: clientR.rows[0],
      scantag,
      message: "Order processed: 1 ScanTag assigned, MyPunctoo enabled, marked ready to invoice.",
    });
  } catch (err) {
    await cx.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    cx.release();
  }
});

// -------------------- MyPunctoo access gate --------------------
app.get("/api/mypunctoo/access", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    return res.json({
      ok: true,
      allowed: true,
      reason: "OK",
      client: {
        client_id: ctx.client.client_id,
        company_name: ctx.client.company_name,
        email: ctx.client.email,
        mypunctoo_enabled_at: ctx.client.mypunctoo_enabled_at,
      },
      scantag: ctx.scantag,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===============================================================
// Employees CRUD (MyPunctoo) - SINGLE SOURCE OF TRUTH
// ===============================================================

// LIST employees
app.get("/api/mypunctoo/employees", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const q = `
      SELECT employee_id, client_id, first_name, last_name, email, created_at, updated_at
      FROM employee
      WHERE client_id = $1
      ORDER BY created_at DESC
    `;
    const r = await pool.query(q, [ctx.client.client_id]);
    return res.json({ ok: true, employees: r.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// CREATE employee
app.post("/api/mypunctoo/employees", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { first_name, last_name, email } = req.body || {};
    if (!first_name || typeof first_name !== "string") {
      return res.status(400).json({ ok: false, error: "first_name is required" });
    }
    if (!last_name || typeof last_name !== "string") {
      return res.status(400).json({ ok: false, error: "last_name is required" });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ ok: false, error: "valid email is required" });
    }

    const q = `
      INSERT INTO employee (client_id, first_name, last_name, email)
      VALUES ($1, $2, $3, $4)
      RETURNING employee_id, client_id, first_name, last_name, email, created_at, updated_at
    `;
    const r = await pool.query(q, [
      ctx.client.client_id,
      first_name.trim(),
      last_name.trim(),
      email.trim().toLowerCase(),
    ]);

    return res.status(201).json({ ok: true, employee: r.rows[0] });
  } catch (err) {
    if ((err.code || "").toString() === "23505") {
      return res.status(409).json({ ok: false, error: "EMPLOYEE_EMAIL_ALREADY_EXISTS" });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// READ employee by id
app.get("/api/mypunctoo/employees/:employee_id", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;

    const q = `
      SELECT employee_id, client_id, first_name, last_name, email, created_at, updated_at
      FROM employee
      WHERE employee_id = $1 AND client_id = $2
      LIMIT 1
    `;
    const r = await pool.query(q, [employee_id, ctx.client.client_id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "employee not found" });

    return res.json({ ok: true, employee: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// UPDATE employee
app.put("/api/mypunctoo/employees/:employee_id", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;
    const { first_name, last_name, email } = req.body || {};

    if (!first_name && !last_name && !email) {
      return res.status(400).json({ ok: false, error: "provide first_name and/or last_name and/or email" });
    }
    if (email && !isEmail(email)) {
      return res.status(400).json({ ok: false, error: "valid email is required" });
    }

    const q = `
      UPDATE employee
      SET
        first_name = COALESCE($3, first_name),
        last_name  = COALESCE($4, last_name),
        email      = COALESCE($5, email),
        updated_at = NOW()
      WHERE employee_id = $1 AND client_id = $2
      RETURNING employee_id, client_id, first_name, last_name, email, created_at, updated_at
    `;
    const r = await pool.query(q, [
      employee_id,
      ctx.client.client_id,
      first_name ? first_name.trim() : null,
      last_name ? last_name.trim() : null,
      email ? email.trim().toLowerCase() : null,
    ]);

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "employee not found" });
    return res.json({ ok: true, employee: r.rows[0] });
  } catch (err) {
    if ((err.code || "").toString() === "23505") {
      return res.status(409).json({ ok: false, error: "EMPLOYEE_EMAIL_ALREADY_EXISTS" });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE employee
app.delete("/api/mypunctoo/employees/:employee_id", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;

    const q = `
      DELETE FROM employee
      WHERE employee_id = $1 AND client_id = $2
      RETURNING employee_id
    `;
    const r = await pool.query(q, [employee_id, ctx.client.client_id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "employee not found" });

    return res.json({ ok: true, deleted: true, employee_id: r.rows[0].employee_id });
  } catch (err) {
    if ((err.code || "").toString() === "23503") {
      return res.status(409).json({ ok: false, error: "EMPLOYEE_IN_USE_CANNOT_DELETE" });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===============================================================
// Scan Events (MyPunctoo)
// ===============================================================

// POST scan event (IN/OUT)
app.post("/api/mypunctoo/employees/:employee_id/scan-events", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;
    const { direction } = req.body || {};

    if (!direction) return res.status(400).json({ ok: false, error: "direction is required" });
    if (direction !== "IN" && direction !== "OUT") {
      return res.status(400).json({ ok: false, error: "direction must be IN or OUT" });
    }

    const own = await requireEmployeeBelongsToClient(employee_id, ctx.client.client_id);
    if (!own.ok) return res.status(own.status).json(own.body);

    // ✅ FIX: scantag_id is NOT NULL in DB → we must insert ctx.scantag.scantag_id
    const q = `
      INSERT INTO public.scan_event (
        scan_event_id,
        client_id,
        scantag_id,
        employee_id,
        direction,
        scanned_at,
        source,
        user_agent,
        ip_address,
        created_at
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4::public.scan_direction,
        NOW(),
        'mypunctoo',
        $5,
        $6::inet,
        NOW()
      )
      RETURNING
        scan_event_id,
        client_id,
        scantag_id,
        employee_id,
        direction,
        scanned_at,
        source,
        created_at;
    `;

    const userAgent = req.headers["user-agent"] || null;
    const ip = normalizeIp(req) || null;

    const r = await pool.query(q, [
      ctx.client.client_id,
      ctx.scantag.scantag_id, // ✅ FIX
      employee_id,
      direction,
      userAgent,
      ip,
    ]);

    return res.status(201).json({ ok: true, event: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET scan events history
app.get("/api/mypunctoo/employees/:employee_id/scan-events", async (req, res) => {
  try {
    const ctx = await getMypunctooContext(req.query.email);
    if (!ctx.ok) return res.status(ctx.status).json(ctx.body);

    const { employee_id } = req.params;

    const limitRaw = (req.query.limit || "50").toString();
    let limit = parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;

    const own = await requireEmployeeBelongsToClient(employee_id, ctx.client.client_id);
    if (!own.ok) return res.status(own.status).json(own.body);

    const q = `
      SELECT
        scan_event_id,
        direction,
        scanned_at,
        source,
        created_at
      FROM public.scan_event
      WHERE client_id = $1 AND employee_id = $2
      ORDER BY scanned_at DESC, created_at DESC
      LIMIT $3
    `;
    const r = await pool.query(q, [ctx.client.client_id, employee_id, limit]);

    const events = r.rows;
    const current_status = events.length ? events[0].direction : null;

    return res.json({ ok: true, employee_id, current_status, events });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------- listen (ALTIJD op het einde) --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
