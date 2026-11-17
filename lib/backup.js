// Daily backup of the live database into Neon and/or Aiven (PostgreSQL).
// Each day becomes its own schema (bk_YYYYMMDD) in the backup database; the last BACKUP_KEEP_DAYS stay.
// Everything is copied: institutions (school / tuition), users (students, teachers, admins, parents), attendance,
// tests, attempts, progress, reviews, homework, announcements, files. Plus readable report tables that say
// which school or tuition each row belongs to.
const { Pool } = require('pg');
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS, 10) || 7);
const SKIP = new Set((process.env.BACKUP_SKIP_TABLES || (process.env.BACKUP_INCLUDE_CONTENT === '1' ? '' : 'mcq_subjects,mcq_chapters,mcq_questions')).split(',').map((s) => s.trim()).filter(Boolean));
const ist = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function makePool(url, ca) {
  const u = new URL(url); u.searchParams.delete('sslmode');
  return new Pool({ connectionString: u.toString(), max: 2, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }) });
}
const targets = () => [['neon', process.env.NEON_BACKUP_URL, null], ['aiven', process.env.AIVEN_BACKUP_URL, process.env.AIVEN_CA_CERT]].filter((t) => t[1]);

async function backupOne(src, name, url, ca, day) {
  const t0 = Date.now(), dst = makePool(url, ca), schema = 'bk_' + day;
  const sc = await src.connect(), dc = await dst.connect();
  const out = { target: name, ok: false, schema, tables: 0, rows: 0 };
  try {
    await dc.query('CREATE TABLE IF NOT EXISTS public.backup_log (id SERIAL PRIMARY KEY, day TEXT, started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ, ok BOOLEAN, rows INT, tables INT, error TEXT)');
    await sc.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');        // one consistent picture of all tables
    await dc.query('DROP SCHEMA IF EXISTS ' + qi(schema) + ' CASCADE'); await dc.query('CREATE SCHEMA ' + qi(schema));
    const tabs = (await sc.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name).filter((t) => !SKIP.has(t));
    for (const t of tabs) {
      const cols = (await sc.query("SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = ('public.' || quote_ident($1))::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", [t])).rows;
      await dc.query('CREATE TABLE ' + qi(schema) + '.' + qi(t) + ' (' + cols.map((c) => qi(c.name) + ' ' + c.type).join(', ') + ')');
      const size = cols.some((c) => c.type === 'bytea') ? 20 : 500;
      let n = 0;
      for (let off = 0; ; off += size) {
        const rows = (await sc.query('SELECT row_to_json(x)::text AS j FROM public.' + qi(t) + ' x ORDER BY ctid LIMIT $1 OFFSET $2', [size, off])).rows;
        if (!rows.length) break;
        await dc.query('INSERT INTO ' + qi(schema) + '.' + qi(t) + ' SELECT * FROM jsonb_populate_recordset(NULL::' + qi(schema) + '.' + qi(t) + ', $1::jsonb)', ['[' + rows.map((r) => r.j).join(',') + ']']);
        n += rows.length;
      }
      const have = Number((await sc.query('SELECT COUNT(*) AS n FROM public.' + qi(t))).rows[0].n);
      const got = Number((await dc.query('SELECT COUNT(*) AS n FROM ' + qi(schema) + '.' + qi(t))).rows[0].n);
      if (have !== got) throw new Error('Row count mismatch in ' + t + ': ' + have + ' vs ' + got);
      out.tables++; out.rows += got;
    }
    // readable reports: every row says which school / tuition it belongs to
    const has = (t) => tabs.includes(t), S = qi(schema) + '.';
    if (has('institutions') && has('users')) await dc.query('CREATE TABLE ' + S + 'report_institutions AS SELECT i.id, i.name, i.type, i.code, i.active, (SELECT COUNT(*) FROM ' + S + 'users u WHERE u.institution_id=i.id AND u.role=\'student\') AS students, (SELECT COUNT(*) FROM ' + S + 'users u WHERE u.institution_id=i.id AND u.role=\'teacher\') AS teachers, (SELECT COUNT(*) FROM ' + S + 'users u WHERE u.institution_id=i.id AND u.role IN (\'admin\',\'inst_owner\')) AS admins FROM ' + S + 'institutions i');
    if (has('institutions') && has('users')) await dc.query('CREATE TABLE ' + S + 'report_people AS SELECT i.name AS institution, i.type AS institution_type, i.code AS institution_code, u.id, u.role, u.name, u.login_id, u.email, u.phone, u.class_name, u.division, u.active FROM ' + S + 'users u LEFT JOIN ' + S + 'institutions i ON i.id=u.institution_id');
    if (has('attendance') && has('users') && has('institutions')) await dc.query('CREATE TABLE ' + S + 'report_attendance AS SELECT i.name AS institution, i.type AS institution_type, a.day, s.name AS student, s.class_name, s.division, a.status FROM ' + S + 'attendance a JOIN ' + S + 'users s ON s.id=a.student_id LEFT JOIN ' + S + 'institutions i ON i.id=a.institution_id');
    if (has('v2_docs') && has('institutions')) await dc.query('CREATE TABLE ' + S + 'report_tests_progress_reviews AS SELECT i.name AS institution, i.type AS institution_type, d.kind, d.id, d.data, d.created_at FROM ' + S + 'v2_docs d LEFT JOIN ' + S + 'institutions i ON i.id::text=d.institution_id');
    out.ok = true;
    await sc.query('COMMIT');
    // keep only the newest KEEP days (only after this one succeeded)
    const old = (await dc.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^bk_[0-9]{8}$' ORDER BY 1 DESC OFFSET $1", [KEEP])).rows;
    for (const o of old) await dc.query('DROP SCHEMA ' + qi(o.schema_name) + ' CASCADE');
  } catch (e) { out.error = e.message; try { await sc.query('ROLLBACK'); } catch (x) { /* ignore */ } }
  finally {
    try { await dc.query('INSERT INTO public.backup_log (day, finished_at, ok, rows, tables, error) VALUES ($1, now(), $2, $3, $4, $5)', [day, out.ok, out.rows, out.tables, out.error || null]); } catch (x) { /* ignore */ }
    sc.release(); dc.release(); await dst.end();
  }
  out.ms = Date.now() - t0;
  return out;
}

async function runBackup() {
  const tg = targets();
  if (!tg.length) throw new Error('Set NEON_BACKUP_URL and/or AIVEN_BACKUP_URL');
  const src = makePool(process.env.DATABASE_URL, process.env.SOURCE_CA_CERT), day = ist();
  try { return await Promise.all(tg.map(([n, u, ca]) => backupOne(src, n, u, ca, day))); } finally { await src.end(); }
}
async function lastLogs() {
  const res = [];
  for (const [n, u, ca] of targets()) { const p = makePool(u, ca); try { res.push({ target: n, last: (await p.query('SELECT day, finished_at, ok, rows, tables, error FROM public.backup_log ORDER BY id DESC LIMIT 3')).rows }); } catch (e) { res.push({ target: n, error: e.message }); } finally { await p.end(); } }
  return res;
}
// copy a day's snapshot back into a database that already has the app tables (run the server once on it first)
async function restore(targetName, day, toUrl) {
  const t = targets().find((x) => x[0] === targetName); if (!t) throw new Error('Unknown target');
  const from = makePool(t[1], t[2]), to = makePool(toUrl, process.env.RESTORE_CA_CERT), schema = 'bk_' + day, c = await to.connect();
  try {
    await c.query('BEGIN');
    const tabs = (await from.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name NOT LIKE 'report\\_%' ESCAPE '\\' ORDER BY 1", [schema])).rows.map((r) => r.table_name);
    await c.query('TRUNCATE ' + tabs.map((x) => 'public.' + qi(x)).join(', ') + ' RESTART IDENTITY CASCADE');
    for (const x of tabs) for (let off = 0; ; off += 200) {
      const rows = (await from.query('SELECT row_to_json(x)::text AS j FROM ' + qi(schema) + '.' + qi(x) + ' x ORDER BY ctid LIMIT 200 OFFSET $1', [off])).rows; if (!rows.length) break;
      await c.query('INSERT INTO public.' + qi(x) + ' SELECT * FROM jsonb_populate_recordset(NULL::public.' + qi(x) + ', $1::jsonb)', ['[' + rows.map((r) => r.j).join(',') + ']']);
    }
    for (const s of (await c.query("SELECT c.table_name, c.column_name, pg_get_serial_sequence('public.' || quote_ident(c.table_name), c.column_name) AS seq FROM information_schema.columns c WHERE c.table_schema='public' AND c.column_default LIKE 'nextval%'")).rows)
      if (s.seq) await c.query('SELECT setval($1, COALESCE((SELECT MAX(' + qi(s.column_name) + ') FROM public.' + qi(s.table_name) + '), 1))', [s.seq]);
    await c.query('COMMIT'); return tabs.length;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); await from.end(); await to.end(); }
}
module.exports = { runBackup, lastLogs, restore, ist };
