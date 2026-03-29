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
    voertuigtype TEXT DEFAULT 'motor',
    share_token TEXT,
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
  CREATE TABLE IF NOT EXISTS herinneringen (
    id TEXT PRIMARY KEY, bike_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    titel TEXT NOT NULL, type TEXT DEFAULT 'km',
    km_grens INTEGER, datum_grens TEXT,
    herhaald INTEGER DEFAULT 0, interval_km INTEGER,
    actief INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY);
`);

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
migrate('bike_share',    'ALTER TABLE bikes ADD COLUMN share_token TEXT');
migrate('bike_type',     'ALTER TABLE bikes ADD COLUMN voertuigtype TEXT DEFAULT \'motor\'');

// ── FOTO UPLOAD ───────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
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
function shareToken() { return require('crypto').randomBytes(20).toString('hex'); }
function owned(bikeId, userId) { return db.prepare('SELECT id FROM bikes WHERE id=? AND user_id=?').get(bikeId, userId); }
function delFile(fp) { if (fp) { try { fs.unlinkSync(path.join(DATA_DIR, fp.replace(/^\/uploads\//,'uploads/'))); } catch {} } }

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
  const { merk, model, jaar, km, kenteken, icon, voertuigtype } = req.body;
  if (!merk || !model) return res.status(400).json({ error: 'Merk en model zijn verplicht.' });
  const id = uid();
  db.prepare('INSERT INTO bikes (id,user_id,merk,model,jaar,km,kenteken,icon,voertuigtype) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.userId, merk, model, jaar||'', km||0, kenteken||'', icon||'🏍️', voertuigtype||'motor');
  res.status(201).json(db.prepare('SELECT * FROM bikes WHERE id=?').get(id));
});

app.put('/api/bikes/:id', requireAuth, (req, res) => {
  const b = db.prepare('SELECT * FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!b) return res.status(404).json({ error: 'Niet gevonden.' });
  const { merk, model, jaar, km, kenteken, icon, voertuigtype } = req.body;
  db.prepare('UPDATE bikes SET merk=?,model=?,jaar=?,km=?,kenteken=?,icon=?,voertuigtype=? WHERE id=?')
    .run(merk||b.merk, model||b.model, jaar??b.jaar, km??b.km, kenteken??b.kenteken, icon||b.icon, voertuigtype||b.voertuigtype, req.params.id);
  res.json(db.prepare('SELECT * FROM bikes WHERE id=?').get(req.params.id));
});

app.delete('/api/bikes/:id', requireAuth, (req, res) => {
  if (!db.prepare('SELECT id FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId))
    return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('DELETE FROM bikes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── DEELLINK ──────────────────────────────────────────────────────────────────
// Deellink aanmaken of ophalen
app.post('/api/bikes/:id/share', requireAuth, (req, res) => {
  const b = db.prepare('SELECT * FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId);
  if (!b) return res.status(404).json({ error: 'Niet gevonden.' });
  let token = b.share_token;
  if (!token) {
    token = shareToken();
    db.prepare('UPDATE bikes SET share_token=? WHERE id=?').run(token, req.params.id);
  }
  res.json({ token, url: `/share/${token}` });
});

// Deellink verwijderen
app.delete('/api/bikes/:id/share', requireAuth, (req, res) => {
  if (!db.prepare('SELECT id FROM bikes WHERE id=? AND user_id=?').get(req.params.id, req.userId))
    return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('UPDATE bikes SET share_token=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Publieke read-only data via share token
app.get('/api/share/:token', (req, res) => {
  const bike = db.prepare('SELECT * FROM bikes WHERE share_token=?').get(req.params.token);
  if (!bike) return res.status(404).json({ error: 'Deellink niet gevonden of verlopen.' });
  const logboek  = db.prepare('SELECT * FROM logboek WHERE bike_id=? ORDER BY datum DESC').all(bike.id);
  const upgrades = db.prepare('SELECT * FROM upgrades WHERE bike_id=? ORDER BY datum DESC').all(bike.id);
  const owner    = db.prepare('SELECT naam FROM users WHERE id=?').get(bike.user_id);
  res.json({ bike: { ...bike, share_token: undefined, user_id: undefined }, logboek, upgrades, owner: owner?.naam });
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

// ── HERINNERINGEN ─────────────────────────────────────────────────────────────
app.get('/api/bikes/:bid/herinneringen', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  res.json(db.prepare('SELECT * FROM herinneringen WHERE bike_id=? ORDER BY created_at DESC').all(req.params.bid));
});

app.post('/api/bikes/:bid/herinneringen', requireAuth, (req, res) => {
  if (!owned(req.params.bid, req.userId)) return res.status(404).json({ error: 'Motor niet gevonden.' });
  const { titel, type, km_grens, datum_grens, herhaald, interval_km } = req.body;
  if (!titel) return res.status(400).json({ error: 'Titel is verplicht.' });
  const id = uid();
  db.prepare('INSERT INTO herinneringen (id,bike_id,user_id,titel,type,km_grens,datum_grens,herhaald,interval_km) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.params.bid, req.userId, titel, type||'km', km_grens||null, datum_grens||null, herhaald?1:0, interval_km||null);
  res.status(201).json(db.prepare('SELECT * FROM herinneringen WHERE id=?').get(id));
});

app.put('/api/bikes/:bid/herinneringen/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM herinneringen WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  const { titel, type, km_grens, datum_grens, herhaald, interval_km, actief } = req.body;
  db.prepare('UPDATE herinneringen SET titel=?,type=?,km_grens=?,datum_grens=?,herhaald=?,interval_km=?,actief=? WHERE id=?')
    .run(titel||it.titel, type||it.type, km_grens??it.km_grens, datum_grens??it.datum_grens,
        herhaald!==undefined?(herhaald?1:0):it.herhaald, interval_km??it.interval_km,
        actief!==undefined?(actief?1:0):it.actief, req.params.id);
  res.json(db.prepare('SELECT * FROM herinneringen WHERE id=?').get(req.params.id));
});

app.delete('/api/bikes/:bid/herinneringen/:id', requireAuth, (req, res) => {
  const it = db.prepare('SELECT * FROM herinneringen WHERE id=? AND bike_id=? AND user_id=?').get(req.params.id, req.params.bid, req.userId);
  if (!it) return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('DELETE FROM herinneringen WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── VERSION ───────────────────────────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version, name: pkg.name });
});


// ── AI ONDERHOUDSINTERVALLEN ──────────────────────────────────────────────────
app.post('/api/ai/onderhoudsintervallen', requireAuth, async (req, res) => {
  const { merk, model, jaar, voertuigtype } = req.body;
  if (!merk || !model) return res.status(400).json({ error: 'Merk en model zijn verplicht.' });
  const voertuigLabel = voertuigtype === 'auto' ? 'personenauto' : voertuigtype === 'camper' ? 'camper/RV' : 'motorfiets';

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
  if (!ANTHROPIC_KEY) {
    return res.json({ intervallen: getGeneriekeIntervallen(merk, model), bron: 'generiek', ai: false });
  }

  const prompt = `Zoek de officiele onderhoudsintervallen voor de ${merk} ${model}${jaar ? ' (' + jaar + ')' : ''} (${voertuigLabel}).
Geef ALLEEN een JSON array terug zonder markdown of uitleg.
Formaat exact:
[{"titel":"Motorolie + filter wisselen","km_interval":6000,"datum_maanden":12,"prioriteit":"hoog"},{"titel":"Luchtfilter vervangen","km_interval":12000,"datum_maanden":24,"prioriteit":"normaal"}]
Velden: titel (string), km_interval (number km of null), datum_maanden (number of null), prioriteit ("hoog"/"normaal"/"laag").
Zoek de officiele servicehandleiding of dealerspecificaties. Maximaal 12 items.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Anthropic API fout');
    }

    const data = await response.json();
    const tekst = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = tekst.replace(/```json|```/g, '').trim();
    const startIdx = clean.indexOf('[');
    const endIdx = clean.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) throw new Error('Geen JSON array gevonden');
    const intervallen = JSON.parse(clean.slice(startIdx, endIdx + 1));
    if (!Array.isArray(intervallen)) throw new Error('Onverwacht formaat');
    res.json({ intervallen, bron: merk + ' ' + model + ' servicehandleiding (AI + web search)', ai: true, voertuigtype });
  } catch (err) {
    console.error('AI interval fout:', err.message);
    res.json({ intervallen: getGeneriekeIntervallen(merk, model, voertuigtype), bron: 'generieke onderhoudsintervallen', ai: false, fout: err.message, voertuigtype });
  }
});

function getGeneriekeIntervallen(merk, model, voertuigtype) {
  if (voertuigtype === 'auto') return [
    { titel: 'Motorolie + filter wisselen', km_interval: 15000, datum_maanden: 12, prioriteit: 'hoog' },
    { titel: 'Luchtfilter vervangen', km_interval: 30000, datum_maanden: 36, prioriteit: 'normaal' },
    { titel: 'Interieurfilter (cabin filter)', km_interval: 15000, datum_maanden: 12, prioriteit: 'normaal' },
    { titel: 'Bougie(s) vervangen', km_interval: 30000, datum_maanden: 48, prioriteit: 'normaal' },
    { titel: 'Remvloeistof vervangen', km_interval: null, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Koelvloeistof vervangen', km_interval: null, datum_maanden: 48, prioriteit: 'normaal' },
    { titel: 'Transmissie-olie vervangen', km_interval: 60000, datum_maanden: null, prioriteit: 'normaal' },
    { titel: 'Remblokken voor controleren', km_interval: 20000, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Remblokken achter controleren', km_interval: 30000, datum_maanden: 36, prioriteit: 'normaal' },
    { titel: 'Ruitenwisserbladen vervangen', km_interval: null, datum_maanden: 12, prioriteit: 'laag' },
    { titel: 'Bandenspanning controleren', km_interval: 1000, datum_maanden: 1, prioriteit: 'hoog' },
    { titel: 'APK keuring', km_interval: null, datum_maanden: 12, prioriteit: 'hoog' },
  ];
  if (voertuigtype === 'camper') return [
    { titel: 'Motorolie + filter wisselen', km_interval: 10000, datum_maanden: 12, prioriteit: 'hoog' },
    { titel: 'Luchtfilter vervangen', km_interval: 20000, datum_maanden: 24, prioriteit: 'normaal' },
    { titel: 'Remvloeistof vervangen', km_interval: null, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Koelvloeistof vervangen', km_interval: null, datum_maanden: 48, prioriteit: 'normaal' },
    { titel: 'Remblokken controleren', km_interval: 20000, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Bandenspanning controleren (incl. reservewiel)', km_interval: 1000, datum_maanden: 1, prioriteit: 'hoog' },
    { titel: 'Gasinstallatie keuren', km_interval: null, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Waterpomp en leidingen controleren', km_interval: null, datum_maanden: 12, prioriteit: 'normaal' },
    { titel: 'Luifel en afdichting controleren', km_interval: null, datum_maanden: 12, prioriteit: 'normaal' },
    { titel: 'Accu (leisure battery) testen', km_interval: null, datum_maanden: 12, prioriteit: 'normaal' },
    { titel: 'APK keuring', km_interval: null, datum_maanden: 12, prioriteit: 'hoog' },
  ];
  // motor (default)
  return [
    { titel: 'Motorolie + filter wisselen', km_interval: 6000, datum_maanden: 12, prioriteit: 'hoog' },
    { titel: 'Luchtfilter vervangen', km_interval: 12000, datum_maanden: 24, prioriteit: 'normaal' },
    { titel: 'Bougie(s) vervangen', km_interval: 12000, datum_maanden: 24, prioriteit: 'normaal' },
    { titel: 'Remvloeistof vervangen', km_interval: null, datum_maanden: 24, prioriteit: 'hoog' },
    { titel: 'Koelvloeistof vervangen', km_interval: null, datum_maanden: 36, prioriteit: 'normaal' },
    { titel: 'Ketting smeren + spanning', km_interval: 500, datum_maanden: null, prioriteit: 'hoog' },
    { titel: 'Ketting + tandwielen vervangen', km_interval: 20000, datum_maanden: null, prioriteit: 'normaal' },
    { titel: 'Remblokken controleren', km_interval: 6000, datum_maanden: 12, prioriteit: 'normaal' },
    { titel: 'Bandenspanning controleren', km_interval: 500, datum_maanden: 1, prioriteit: 'hoog' },
    { titel: 'APK keuring', km_interval: null, datum_maanden: 12, prioriteit: 'hoog' },
  ];
}

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_JWT_SECRET = JWT_SECRET + '_admin';

function requireAdmin(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Niet ingelogd als admin.' });
  try {
    const p = jwt.verify(h.slice(7), ADMIN_JWT_SECRET);
    if (p.role !== 'admin') throw new Error('Geen admin');
    next();
  } catch { res.status(401).json({ error: 'Admin sessie verlopen.' }); }
}

// POST /api/admin/login
app.post('/api/admin/login', rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Te veel pogingen.' } }), (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD niet ingesteld in .env' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Onjuist admin wachtwoord.' });
  const token = jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
  res.json({ token });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const users     = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const bikes     = db.prepare('SELECT COUNT(*) as c FROM bikes').get().c;
  const logboek   = db.prepare('SELECT COUNT(*) as c FROM logboek').get().c;
  const upgrades  = db.prepare('SELECT COUNT(*) as c FROM upgrades').get().c;
  const herinneringen = db.prepare('SELECT COUNT(*) as c FROM herinneringen').get().c;

  // Schijfgebruik
  let dbSize = 0, uploadSize = 0, uploadCount = 0;
  try { dbSize = fs.statSync(path.join(DATA_DIR, 'garagebook.db')).size; } catch {}
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    uploadCount = files.length;
    uploadSize = files.reduce((s, f) => {
      try { return s + fs.statSync(path.join(UPLOAD_DIR, f)).size; } catch { return s; }
    }, 0);
  } catch {}

  // Registraties per maand (laatste 6 maanden)
  const registraties = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as maand, COUNT(*) as aantal
    FROM users
    WHERE created_at >= date('now', '-6 months')
    GROUP BY maand ORDER BY maand
  `).all();

  res.json({ users, bikes, logboek, upgrades, herinneringen, dbSize, uploadSize, uploadCount, registraties,
    versie: require('./package.json').version, uptime: process.uptime() });
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.naam, u.email, u.created_at,
      COUNT(DISTINCT b.id) as bikes,
      COUNT(DISTINCT l.id) as logboek,
      COUNT(DISTINCT up.id) as upgrades
    FROM users u
    LEFT JOIN bikes b ON b.user_id = u.id
    LEFT JOIN logboek l ON l.user_id = u.id
    LEFT JOIN upgrades up ON up.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// GET /api/admin/users/:id
app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user  = db.prepare('SELECT id,naam,email,created_at FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
  const bikes = db.prepare('SELECT * FROM bikes WHERE user_id=? ORDER BY created_at').all(req.params.id);
  const bikeIds = bikes.map(b => b.id);
  const logboek  = bikeIds.length ? db.prepare(`SELECT * FROM logboek WHERE bike_id IN (${bikeIds.map(()=>'?').join(',')}) ORDER BY datum DESC`).all(...bikeIds) : [];
  const upgrades = bikeIds.length ? db.prepare(`SELECT * FROM upgrades WHERE bike_id IN (${bikeIds.map(()=>'?').join(',')}) ORDER BY datum DESC`).all(...bikeIds) : [];
  res.json({ user, bikes, logboek, upgrades });
});

// PUT /api/admin/users/:id
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Niet gevonden.' });
  const { naam, email, password } = req.body;
  if (email && email !== user.email) {
    const exists = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email.toLowerCase(), req.params.id);
    if (exists) return res.status(409).json({ error: 'E-mailadres al in gebruik.' });
  }
  let hash = user.password_hash;
  if (password && password.length >= 6) hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET naam=?, email=?, password_hash=? WHERE id=?')
    .run(naam||user.naam, email||user.email, hash, req.params.id);
  res.json(db.prepare('SELECT id,naam,email,created_at FROM users WHERE id=?').get(req.params.id));
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Niet gevonden.' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    anthropic_key_set: !!(process.env.ANTHROPIC_API_KEY),
    anthropic_key_preview: process.env.ANTHROPIC_API_KEY
      ? process.env.ANTHROPIC_API_KEY.slice(0,12) + '...' : null,
    port: PORT,
    data_dir: DATA_DIR
  });
});

// POST /api/admin/settings
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { anthropic_api_key } = req.body;
  if (!anthropic_api_key) return res.status(400).json({ error: 'API key is verplicht.' });
  const envPath = '/etc/garagebook.env';
  try {
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf8'); } catch {}
    if (envContent.includes('ANTHROPIC_API_KEY=')) {
      envContent = envContent.replace(/ANTHROPIC_API_KEY=.*/g, `ANTHROPIC_API_KEY=${anthropic_api_key}`);
    } else {
      envContent += `\nANTHROPIC_API_KEY=${anthropic_api_key}`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n');
    process.env.ANTHROPIC_API_KEY = anthropic_api_key;
    res.json({ ok: true, preview: anthropic_api_key.slice(0,12) + '...' });
  } catch(e) {
    res.status(500).json({ error: 'Kon .env niet schrijven: ' + e.message });
  }
});

// GET /api/admin/backups
app.get('/api/admin/backups', requireAdmin, (req, res) => {
  const backupDir = '/var/backups/garagebook';
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db.gz') || f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { naam: f, grootte: stat.size, datum: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.datum) - new Date(a.datum));
    res.json(files);
  } catch { res.json([]); }
});

// GET /api/admin/backups/:naam/download
app.get('/api/admin/backups/:naam/download', (req, res, next) => {
  // Accepteer token via query param voor downloads (browser navigatie)
  const qToken = req.query.token;
  if (qToken) req.headers.authorization = 'Bearer ' + qToken;
  next();
}, requireAdmin, (req, res) => {
  const naam = path.basename(req.params.naam);
  const filePath = path.join('/var/backups/garagebook', naam);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Bestand niet gevonden.' });
  res.download(filePath, naam);
});

// POST /api/admin/backups/create
app.post('/api/admin/backups/create', requireAdmin, (req, res) => {
  const { execSync } = require('child_process');
  try {
    execSync('/usr/local/bin/garagebook-backup', { timeout: 30000 });
    res.json({ ok: true });
  } catch(e) {
    // Fallback: directe SQLite backup
    try {
      const backupDir = '/var/backups/garagebook';
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const datum = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const dest = path.join(backupDir, `garagebook_${datum}.db`);
      db.backup(dest).then(() => {
        const { execSync: ex } = require('child_process');
        try { ex(`gzip -9 "${dest}"`); } catch {}
        res.json({ ok: true });
      }).catch(err => res.status(500).json({ error: err.message }));
    } catch(e2) { res.status(500).json({ error: e2.message }); }
  }
});

// DELETE /api/admin/backups/:naam
app.delete('/api/admin/backups/:naam', requireAdmin, (req, res) => {
  const naam = path.basename(req.params.naam);
  const filePath = path.join('/var/backups/garagebook', naam);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Niet gevonden.' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// Serve admin frontend
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin.html')));


// ── CATCH-ALL ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.listen(PORT, () => console.log(`GarageBook v${require('./package.json').version} running on port ${PORT}`));
