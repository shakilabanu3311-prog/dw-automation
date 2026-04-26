'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./lib/db');
const A = require('./lib/auth');
const authRoutes = require('./routes/auth');
const entryRoutes = require('./routes/entries');
const ingestRoutes = require('./routes/ingest');
const sheetRoutes = require('./routes/sheet');
const reconcileRoutes = require('./routes/reconcile');
const branchRoutes = require('./routes/branches');
const { currentBusinessDate } = require('./lib/businessDate');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

function bootstrap() {
  // Seed a default panel_map ONLY if none exists.
  //
  // ⚠ NOTE: 'freeplay24:MAHA0001 → 1XBET0001' is a TESTING-ONLY default.
  // The MAHA0001 account on Freeplay24 is being used by the customer to dry-
  // run the integration end-to-end. Real production panels (1XBET0001..0006)
  // map to different real masters once go-live happens. Admin should overwrite
  // these via Settings → Panel Mapping before going live with real data.
  try {
    const has = db.prepare("SELECT 1 FROM settings WHERE key='panel_map'").get();
    if (!has) {
      const seed = {
        // Testing master → real B1 panel for the dry-run.
        'freeplay24:MAHA0001': '1XBET0001',  // ⚠ TESTING ONLY
        // Real masters that the extension will see once live.
        // Branch 1 — 1XBET 0001..0004
        'freeplay24:1XBET0001': '1XBET0001',
        'freeplay24:1XBET0002': '1XBET0002',
        'freeplay24:1XBET0003': '1XBET0003',
        'freeplay24:1XBET0004': '1XBET0004',
        // Branch 2 — Laser + Radhe
        'freeplay24:LASER0001': 'LASER0001',
        'freeplay24:LASER0002': 'LASER0002',
        'freeplay24:LASER0003': 'LASER0003',
        'freeplay24:RADHE':     'RADHE',
        // Branch 3 — Tiger Exch + 1X Club
        'freeplay24:TIGEREXCH0001': 'TIGEREXCH0001',
        'freeplay24:1XCLUB0001':    '1XCLUB0001',
      };
      db.prepare("INSERT INTO settings(key,value) VALUES('panel_map', ?)").run(JSON.stringify(seed));
      console.log('[bootstrap] seeded panel_map for all branches');
    }
  } catch (e) { console.error('[bootstrap] panel_map seed failed', e.message); }

  // Seed branches table — idempotent. Updates panel_slugs if BRANCHES list changed.
  try {
    const M = require('./lib/sheetMap');
    const upsert = db.prepare(`
      INSERT INTO branches(code, name, panel_slugs, is_aggregate, sort_order)
      VALUES (?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET
        name=excluded.name, panel_slugs=excluded.panel_slugs,
        is_aggregate=excluded.is_aggregate, sort_order=excluded.sort_order
    `);
    M.BRANCHES.forEach((b, i) => {
      const slugs = b.is_aggregate ? M.allPanelSlugs() : b.panels.map(p => p.slug);
      upsert.run(b.code, b.name, JSON.stringify(slugs), b.is_aggregate ? 1 : 0, i);
    });
    console.log('[bootstrap] seeded', M.BRANCHES.length, 'branches');
  } catch (e) { console.error('[bootstrap] branches seed failed', e.message); }

  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const admin = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'admin123';
    db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)')
      .run(admin, A.hashPassword(pass), 'admin');
    console.log(`[bootstrap] created initial admin user: ${admin} / ${pass}  (change immediately)`);
  }
  // Auto-register the bundled master sheet as the default template (for testing)
  const fs = require('fs');
  const tplDefault = path.join(__dirname, '..', 'sheet.xlsx');
  const tplDest = path.join(__dirname, '..', 'data', 'templates', 'master.xlsx');
  if (fs.existsSync(tplDefault)) {
    fs.mkdirSync(path.dirname(tplDest), { recursive: true });
    if (!fs.existsSync(tplDest)) fs.copyFileSync(tplDefault, tplDest);
    db.prepare(
      `INSERT INTO settings(key, value) VALUES ('sheet_template_path', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(tplDest);
    console.log('[bootstrap] sheet template registered:', tplDest);
  }
}
bootstrap();

// Build a fresh zip from a source folder if older than the folder mtime.
async function ensureZip(srcDir, outZip) {
  const fs = require('fs');
  const archiver = require('archiver');
  const SKIP = new Set(['node_modules','build','.gradle','.idea','.cxx','.externalNativeBuild','captures']);
  function newest(dir) {
    let max = 0; let stack = [dir]; let n = 0;
    while (stack.length && n < 5000) {
      const d = stack.pop();
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        n++;
        if (SKIP.has(e.name)) continue;
        const p = path.join(d, e.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > max) max = st.mtimeMs;
          if (e.isDirectory()) stack.push(p);
        } catch (_) {}
      }
    }
    return max;
  }
  if (!fs.existsSync(srcDir)) throw new Error('source missing: ' + srcDir);
  const srcMtime = newest(srcDir);
  let outMtime = 0; try { outMtime = fs.statSync(outZip).mtimeMs; } catch (_) {}
  if (fs.existsSync(outZip) && srcMtime <= outMtime) return outZip;
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  try { fs.unlinkSync(outZip); } catch (_) {}
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.glob('**/*', {
      cwd: srcDir,
      ignore: ['**/node_modules/**','**/build/**','**/.gradle/**','**/.idea/**',
               '**/.cxx/**','**/.externalNativeBuild/**','**/captures/**'],
      dot: false,
    });
    archive.finalize();
  });
  return outZip;
}

// Download the Chrome extension as a zip
app.get('/extension.zip', async (req, res) => {
  try {
    const out = await ensureZip(
      path.join(__dirname, '..', 'extension'),
      path.join(__dirname, '..', 'data', 'extension.zip'));
    res.download(out, 'b2c-hisab-extension.zip');
  } catch (e) { res.status(500).send('zip failed: ' + e.message); }
});

// Download the Android app source as a zip (excludes build, .gradle, .idea)
app.get('/android-source.zip', async (req, res) => {
  try {
    const out = await ensureZip(
      path.join(__dirname, '..', 'android'),
      path.join(__dirname, '..', 'data', 'android-source.zip'));
    res.download(out, 'b2c-hisab-android-source.zip');
  } catch (e) { res.status(500).send('zip failed: ' + e.message); }
});

// Download the prebuilt debug APK if present
app.get('/android-debug.apk', (req, res) => {
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(__dirname, '..', 'data', 'app-debug.apk'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return res.download(p, 'b2c-hisab.apk');
  res.status(404).send('No APK built yet. Run `./gradlew assembleDebug` in the android/ folder.');
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, business_date: currentBusinessDate(), time: new Date().toISOString() });
});

// Live Google Sheets sync — fires after any mutation under /api (except auth/health).
// Debounced inside scheduleLiveSync so bulk imports don't spam the API.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/auth') || req.path.startsWith('/health')) return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const { scheduleLiveSync } = require('./lib/googleSheetWriter');
        const date = (req.body && (req.body.business_date || (req.body.ts && require('./lib/businessDate').businessDate(req.body.ts))))
                  || require('./lib/businessDate').currentBusinessDate();
        scheduleLiveSync(date);
      } catch (_) {}
    }
  });
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/ingest', ingestRoutes);
app.use('/api/sheet', sheetRoutes);
app.use('/api/reconcile', reconcileRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api', entryRoutes);

app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  B2C Hisab server running:  http://localhost:${PORT}\n  DB:  ${require('./lib/db').DB_PATH}\n`);
  try { require('./lib/rollover').start(); } catch (e) { console.error('rollover scheduler:', e); }
});
