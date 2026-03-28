const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const DATA_DIR = process.env.DATA_DIR || '/var/lib/garagebook';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

[DATA_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'garagebook.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    naam TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bikes (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
    merk TEXT NOT NULL, model TEXT NOT NULL, jaar TEXT,
    km INTEGER DEFAULT 0, kenteken TEXT, icon TEXT DEFAULT '🏍️',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS logboek (
    id TEXT PRIMARY KEY, bike_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    datum TEXT, type TEXT NOT NULL, beschrijving TEXT NOT NULL,
    notities TEXT, km INTEGER DEFAULT 0, kosten REAL DEFAULT 0,
    garage TEXT, foto TEXT, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS upgrades (
    id TEXT PRIMARY KEY, bike_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    naam TEXT NOT NULL, beschrijving TEXT, merk TEXT, cat TEXT,
    kosten REAL DEFAULT 0, datum TEXT, installer TEXT, foto TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY);
`);

// Migraties voor bestaande databases
function migrate(key, sql) {
  if (!db.prepare('SELECT key FROM _migrations WHERE key=?').get(key)) {
    try { db.exec(sql); } catch {}
    db.prepare('INSERT OR IGNORE INTO _migrations VALUES (?)').run(key);
  }
}
migrate('log_foto',      'ALTER TABLE logboek ADD COLUMN foto TEXT');
migrate('log_notities',  'ALTER TABLE logboek ADD COLUMN notities TEXT');
migrate('up_foto',       'ALTER TABLE upgrades ADD COLUMN foto TEXT');
migrate('up_beschr',     'ALTER TABLE upgrades ADD COLUMN beschrijving TEXT');

// ── FOTO UPLOAD ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Alleen afbeeldingen toegestaan.'), ok);
  }
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Te veel pogingen.' } }));
app.use('/api', rateLimit({ windowMs: 60*1000, max: 300 }));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Niet ingelogd.' });
  try { const p = jwt.verify(h.slice(7), JWT_SECRET); req.userId = p.userId; next(); }
  catch { res.status(401).json({ error: 'Sessie verlopen.' }); }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function owned(bikeId, userId) { return db.prepare('SELECT id FROM bikes WHERE id=? AND user_id=?').get(bikeId, userId); }
function delFile(filePath) { if (filePath) { try { fs.unlinkSync(path.join(DATA_DIR, filePath.replace(/^\/uploads\//,'uploads/'))); } catch {} } }

// ── UPLOAD ────────────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('foto'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Geen bestand.' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { naam, email, password } = req.body;
  if (!naam || !email || !password) return res.status(400).json({ error: 'Vul alle velden in.' });
  if (!email.includes('@')) return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
  if (password.length < 6) return res.status(400).json({ error: 'Wachtwoord minimaal 6 tekens.' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase()))
    return res.status(409).json({ error: 'E-mailadres al geregistreerd.' });
  const hash = await bcrypt.hash(password, 12);
  const r = db.prepare('INSERT INTO users (naam,email,password_hash) VALUES (?,?,?)').run(naam, email.toLowerCase(), hash);
  const token = jwt.sign({ userId: r.lastInsertRowid }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: r.lastInsertRowid, naam, email: email.toLowerCase() } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Vul e-mail en wachtwoord in.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Geen account gevonden.' });
  if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Onjuist wachtwoord.' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, naam: user.naam, email: user.email } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id,naam,email FROM users WHERE id=?').get(req.userId);
  u ? res.json(u) : res.status(404).json({ error: 'Niet gevonden.' });
});

// ── BIKES ─────────────────────────────────────────────────────────────────────
app.get('/api/bikes', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM bikes WHERE user_id=? ORDER BY created_at').all(req.userId)));

app.post('/api/bikes', requireAuth, (req, res) => {
  const { merk, model, jaar, km, kenteken, icon } = req.body;
  if (!merk || !model) return res.status(400).json({ error: 'Merk en model zijn verplicht.' });
  const id = uid();
  db.prepare('INSERT INTO bikes (id,user_id,merk,model,jaar,km,kenteken,icon) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.userId, merk, model, jaar||'', km||0, kenteken||'', icon||'🏍️');
  res.status(201).json(db.prepare('SELECT * FROM bikes WHERE id=?').get(id));
});

app.put('/api/bikes/:id', requireAuth, (req, res) => {
  const b = db.prepare('SELECT * FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!b) return res.status(404).json({ error: 'Niet gevonden.' });
  const { merk, model, jaar, km, kenteken, icon } = req.body;
  db.prepare('UPDATE bikes SET merk=?,model=?,jaar=?,km=?,kenteken=?,icon=? WHERE id=?')
    .run(merk||b.merk, model||b.model, jaar??b.jaar, km??b.km, kenteken??b.kenteken, icon||b.icon, req.params.id);
  res.json(db.prepare('SELECT * FROM bikes WHERE id=?').get(req.params.id));
});

app.delete('/api/bikes/:id', requireAuth, (req, res) => {
  if (!db.prepare('SELECT id FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId))
    return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('DELETE FROM bikes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── LOGBOEK ───────────────────────────────────────────────────────────────────
app.get('/api/bikes/:bid/logboek', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  res.json(db.prepare('SELECT * FROM logboek WHERE bike_id=? ORDER BY datum DESC, created_at DESC').all(req.params.bid));
});

app.post('/api/bikes/:bid/logboek', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  const { datum, type, beschrijving, notities, km, kosten, garage, foto } = req.body;
  if (!type || !beschrijving) return res.status(400).json({ error: 'Type en beschrijving zijn verplicht.' });
  const id = uid();
  db.prepare('INSERT INTO logboek (id,bike_id,user_id,datum,type,beschrijving,notities,km,kosten,garage,foto) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.bid, req.userId, datum||'', type, beschrijving, notities||'', km||0, kosten||0, garage||'', foto||null);
  res.status(201).json(db.prepare('SELECT * FROM logboek WHERE id=?').get(id));
});

app.put('/api/bikes/:bid/logboek/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM logboek WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  const { datum, type, beschrijving, notities, km, kosten, garage, foto } = req.body;
  db.prepare('UPDATE logboek SET datum=?,type=?,beschrijving=?,notities=?,km=?,kosten=?,garage=?,foto=? WHERE id=?')
    .run(datum??it.datum, type||it.type, beschrijving||it.beschrijving, notities??it.notities,
        km??it.km, kosten??it.kosten, garage??it.garage, foto!==undefined?foto:it.foto, req.params.id);
  res.json(db.prepare('SELECT * FROM logboek WHERE id=?').get(req.params.id));
});

app.delete('/api/bikes/:bid/logboek/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM logboek WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  delFile(it.foto);
  db.prepare('DELETE FROM logboek WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── UPGRADES ──────────────────────────────────────────────────────────────────
app.get('/api/bikes/:bid/upgrades', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  res.json(db.prepare('SELECT * FROM upgrades WHERE bike_id=? ORDER BY datum DESC, created_at DESC').all(req.params.bid));
});

app.post('/api/bikes/:bid/upgrades', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  const { naam, beschrijving, merk, cat, kosten, datum, installer, foto } = req.body;
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht.' });
  const id = uid();
  db.prepare('INSERT INTO upgrades (id,bike_id,user_id,naam,beschrijving,merk,cat,kosten,datum,installer,foto) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.bid, req.userId, naam, beschrijving||'', merk||'', cat||'overig', kosten||0, datum||'', installer||'', foto||null);
  res.status(201).json(db.prepare('SELECT * FROM upgrades WHERE id=?').get(id));
});

app.put('/api/bikes/:bid/upgrades/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM upgrades WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  const { naam, beschrijving, merk, cat, kosten, datum, installer, foto } = req.body;
  db.prepare('UPDATE upgrades SET naam=?,beschrijving=?,merk=?,cat=?,kosten=?,datum=?,installer=?,foto=? WHERE id=?')
    .run(naam||it.naam, beschrijving??it.beschrijving, merk??it.merk, cat||it.cat,
        kosten??it.kosten, datum??it.datum, installer??it.installer, foto!==undefined?foto:it.foto, req.params.id);
  res.json(db.prepare('SELECT * FROM upgrades WHERE id=?').get(req.params.id));
});

app.delete('/api/bikes/:bid/upgrades/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM upgrades WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  delFile(it.foto);
  db.prepare('DELETE FROM upgrades WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── VERSION ───────────────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version, name: pkg.name });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.listen(PORT, () => console.log(`GarageBook running on port ${PORT}`));
