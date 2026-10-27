// TradeDesk backend: Express + SQLite + JWT.  Run: npm install && node server.js
const express = require("express"), cors = require("cors"), jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs"), Database = require("better-sqlite3"), path = require("path");
const SECRET = process.env.JWT_SECRET || "change-me-in-production";
const db = new Database(process.env.DB_FILE || path.join(__dirname, "tradedesk.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS profiles(user_id INTEGER PRIMARY KEY, name TEXT, phone TEXT, biz TEXT, gst TEXT, addr TEXT, photo TEXT);
CREATE TABLE IF NOT EXISTS commodities(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, unit TEXT, rate REAL, min REAL, max REAL,
  comm REAL DEFAULT 0, fee REAL DEFAULT 0, gst INTEGER DEFAULT 0, gst_type TEXT DEFAULT 'GST', gst_pct REAL DEFAULT 0,
  gst_no TEXT, prefix TEXT, hsn TEXT, coolie REAL DEFAULT 0, calc TEXT, deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS uq_name ON commodities(user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefix ON commodities(user_id, prefix) WHERE deleted_at IS NULL;`);

for (const col of ["hsn TEXT", "coolie REAL DEFAULT 0", "calc TEXT"]) { try { db.exec("ALTER TABLE commodities ADD COLUMN " + col); } catch {} } // upgrade older DB files
const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstCheck(v) {
  v = (v || "").trim().toUpperCase();
  if (v.length !== 15) return "GST number must be exactly 15 characters";
  if (!/^(0[1-9]|[12]\d|3[0-8])/.test(v)) return "Invalid state code (first 2 digits must be 01–38)";
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return "Wrong format. Example: 27AAPFU0939F1ZV";
  let s = 0;
  for (let i = 0; i < 14; i++) { const p = CH.indexOf(v[i]) * (i % 2 ? 2 : 1); s += Math.floor(p / 36) + (p % 36); }
  return CH[(36 - (s % 36)) % 36] === v[14] ? "" : "Invalid GST number (checksum mismatch)";
}
const fail = (res, code, error, field, extra) => res.status(code).json({ error, field, ...extra });
const app = express();
app.use(cors()); app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const sign = (u) => jwt.sign({ uid: u.id }, SECRET, { expiresIn: "7d" });
const auth = (req, res, next) => {
  try { req.uid = jwt.verify((req.headers.authorization || "").slice(7), SECRET).uid; next(); }
  catch { fail(res, 401, "Session expired. Please log in again"); }
};
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/auth/signup", (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "") || (password || "").length < 6) return fail(res, 400, "Enter name, valid email and a password of 6+ characters");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email.toLowerCase())) return fail(res, 409, "Account already exists. Please log in");
  const r = db.prepare("INSERT INTO users(email,name,pass_hash) VALUES(?,?,?)").run(email.toLowerCase(), name.trim(), bcrypt.hashSync(password, 10));
  res.json({ token: sign({ id: r.lastInsertRowid }), name: name.trim(), email: email.toLowerCase() });
});
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(password || "", u.pass_hash)) return fail(res, 401, "Incorrect email or password");
  res.json({ token: sign(u), name: u.name, email: u.email });
});

app.get("/api/profile", auth, (req, res) => res.json(db.prepare("SELECT * FROM profiles WHERE user_id=?").get(req.uid) || {}));
app.put("/api/profile", auth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !/^[6-9]\d{9}$/.test(b.phone || "")) return fail(res, 400, "Name and a valid 10-digit mobile number are required");
  if (b.gst && gstCheck(b.gst)) return fail(res, 400, gstCheck(b.gst), "gst");
  const old = db.prepare("SELECT photo FROM profiles WHERE user_id=?").get(req.uid);
  const photo = b.photo === undefined ? (old && old.photo) : b.photo;
  db.prepare(`INSERT INTO profiles(user_id,name,phone,biz,gst,addr,photo) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,biz=excluded.biz,gst=excluded.gst,addr=excluded.addr,photo=excluded.photo`)
    .run(req.uid, b.name, b.phone, b.biz || "", (b.gst || "").toUpperCase(), b.addr || "", photo || null);
  res.json({ ok: true });
});

const out = (r) => ({ id: String(r.id), name: r.name, unit: r.unit, rate: r.rate, min: r.min, max: r.max, comm: r.comm, fee: r.fee,
  gst: !!r.gst, gstType: r.gst_type, gstPct: r.gst_pct, gstNo: r.gst_no, prefix: r.prefix, hsn: r.hsn || "", coolie: r.coolie || 0, calc: r.calc ? JSON.parse(r.calc) : undefined, deletedAt: r.deleted_at || undefined });
app.get("/api/commodities", auth, (req, res) =>
  res.json(db.prepare("SELECT * FROM commodities WHERE user_id=? ORDER BY id DESC").all(req.uid).map(out)));

function calcErr(c) {
  if (!c) return "";
  if (c.ded && c.ded.on) {
    if (!c.ded.rows.length) return "Add at least one deduction slab";
    for (const r of c.ded.rows) if (!(r.a >= 0 && r.b > r.a && r.c >= 0)) return "Invalid deduction slab";
  }
  if (c.rnd && c.rnd.on) {
    const rs = c.rnd.rows;
    if (!rs.length || rs[0].a !== 0 || rs[rs.length - 1].b !== 1) return "Round-off bands must cover 0 to 1";
    for (let i = 0; i < rs.length; i++) {
      if (!(rs[i].b > rs[i].a) || rs[i].c < 0 || rs[i].c > 1) return "Invalid round-off band";
      if (i && rs[i].a !== rs[i - 1].b) return "Round-off bands must have no gaps";
    }
  }
  return "";
}
function check(b, uid, id) {
  if (!b.name || !b.name.trim()) return ["name", "Commodity name is required"];
  if (!(b.rate > 0)) return ["rate", "Enter a rate greater than 0"];
  if (!(b.max > 0) || b.min < 0 || b.min >= b.max) return ["min", "Min weight must be less than max weight, and max must be above 0"];
  if (b.comm < 0 || b.comm > 100) return ["comm", "Commission must be between 0 and 100"];
  if (b.gst && !/^(\d{6}|\d{8})$/.test(b.hsn || "")) return ["hsn", "Enter a 6-digit HSN or 8-digit SAC code"];
  if (b.gst && gstCheck(b.gstNo)) return ["gstNo", gstCheck(b.gstNo)];
  if (calcErr(b.calc)) return ["calc", calcErr(b.calc)];
  if (!/^[A-Z0-9]{2,6}$/.test(b.prefix || "")) return ["prefix", "Prefix must be 2–6 letters or digits"];
  const same = db.prepare("SELECT * FROM commodities WHERE user_id=? AND lower(name)=lower(?) AND id<>?").all(uid, b.name.trim(), id || 0);
  const act = same.find((r) => !r.deleted_at), gone = same.find((r) => r.deleted_at);
  if (act) return ["name", `“${act.name}” already exists`];
  if (gone) return ["name", `“${gone.name}” already exists in deleted items`, String(gone.id)];
  if (db.prepare("SELECT 1 FROM commodities WHERE user_id=? AND prefix=? AND id<>? AND deleted_at IS NULL").get(uid, b.prefix, id || 0)) return ["prefix", "This bill prefix is already used by another commodity"];
  return null;
}
function vals(b) { return [b.name.trim(), b.unit || "kg", b.rate, b.min, b.max, b.comm || 0, b.fee || 0, b.gst ? 1 : 0, b.gstType || "GST", b.gstPct || 0, b.gst ? b.gstNo.toUpperCase() : "", b.prefix, b.gst ? b.hsn : "", b.coolie || 0, b.calc ? JSON.stringify(b.calc) : null]; }
app.post("/api/commodities", auth, (req, res) => {
  const e = check(req.body, req.uid); if (e) return fail(res, 409, e[1], e[0], { restoreId: e[2] });
  db.prepare("INSERT INTO commodities(user_id,name,unit,rate,min,max,comm,fee,gst,gst_type,gst_pct,gst_no,prefix,hsn,coolie,calc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(req.uid, ...vals(req.body));
  res.json({ ok: true });
});
app.put("/api/commodities/:id", auth, (req, res) => {
  const e = check(req.body, req.uid, +req.params.id); if (e) return fail(res, 409, e[1], e[0], { restoreId: e[2] });
  db.prepare("UPDATE commodities SET name=?,unit=?,rate=?,min=?,max=?,comm=?,fee=?,gst=?,gst_type=?,gst_pct=?,gst_no=?,prefix=?,hsn=?,coolie=?,calc=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").run(...vals(req.body), req.params.id, req.uid);
  res.json({ ok: true });
});
// SOFT delete: the row is kept, only deleted_at is set. There is no DELETE FROM anywhere.
app.delete("/api/commodities/:id", auth, (req, res) => {
  db.prepare("UPDATE commodities SET deleted_at=datetime('now') WHERE id=? AND user_id=?").run(req.params.id, req.uid);
  res.json({ ok: true });
});
app.post("/api/commodities/:id/restore", auth, (req, res) => {
  const r = db.prepare("SELECT * FROM commodities WHERE id=? AND user_id=?").get(req.params.id, req.uid);
  if (!r) return fail(res, 404, "Not found");
  const clash = db.prepare("SELECT 1 FROM commodities WHERE user_id=? AND deleted_at IS NULL AND (lower(name)=lower(?) OR prefix=?)").get(req.uid, r.name, r.prefix);
  if (clash) return fail(res, 409, "An active commodity with this name or bill prefix already exists");
  db.prepare("UPDATE commodities SET deleted_at=NULL WHERE id=?").run(r.id);
  res.json({ ok: true });
});
app.listen(process.env.PORT || 4000, () => console.log("TradeDesk running on http://localhost:" + (process.env.PORT || 4000)));
