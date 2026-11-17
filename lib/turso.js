// Chapter-wise content for Class 6 to 12 kept in Turso (libSQL / SQLite).
// The backend only READS from Turso. It finds the table and columns by itself;
// if your column names are unusual, set TURSO_MAP (see README).
//
//   TURSO_DATABASE_URL = libsql://your-db-name-yourname.turso.io
//   TURSO_AUTH_TOKEN   = (read-only token is enough)
//   TURSO_MAP          = optional JSON, e.g. {"table":"mcq","std":"class_no","subject":"subject","chapter":"chapter","question":"q","options":["a","b","c","d"],"answer":"correct"}

const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (id) => { if (!SAFE.test(id)) throw new Error('Unsafe column or table name: ' + id); return '"' + id + '"'; };

const GUESS = {
  std: ['std', 'standard', 'class', 'class_no', 'classno', 'class_num', 'grade', 'std_no', 'class_name'],
  subject: ['subject', 'subject_name', 'subj'],
  chapter: ['chapter', 'chapter_name', 'chapter_title', 'chapter_no_name', 'topic', 'unit'],
  question: ['question', 'question_text', 'ques', 'q', 'questions', 'text'],
  options: ['options', 'choices', 'option_list'],
  answer: ['answer', 'correct', 'correct_answer', 'correct_option', 'ans', 'right_answer', 'correct_ans'],
  id: ['id', 'qid', 'question_id', 'q_id'],
  explanation: ['explanation', 'solution', 'hint', 'reason'],
};
const OPTION_SETS = [['option_a', 'option_b', 'option_c', 'option_d'], ['opt_a', 'opt_b', 'opt_c', 'opt_d'], ['option1', 'option2', 'option3', 'option4'], ['opt1', 'opt2', 'opt3', 'opt4'], ['option_1', 'option_2', 'option_3', 'option_4'], ['a', 'b', 'c', 'd'], ['optiona', 'optionb', 'optionc', 'optiond']];

// tables: { tableName: [columnName, ...] }  ->  { table, std, subject, chapter, question, options:[...]|'col', answer, id?, explanation? } or null
function detectMapping(tables, override) {
  const ov = override || {};
  const names = Object.keys(tables);
  const score = (t) => {
    const cols = tables[t].map((c) => c.toLowerCase());
    const has = (k) => GUESS[k].some((g) => cols.includes(g));
    const hasOpts = has('options') || OPTION_SETS.some((s) => s.every((c) => cols.includes(c)));
    return (has('std') ? 1 : 0) + (has('subject') ? 1 : 0) + (has('chapter') ? 1 : 0) + (has('question') ? 2 : 0) + (hasOpts ? 2 : 0) + (has('answer') ? 1 : 0) + (/mcq|question|quiz/.test(t.toLowerCase()) ? 1 : 0);
  };
  const table = ov.table && tables[ov.table] ? ov.table : names.slice().sort((a, b) => score(b) - score(a))[0];
  if (!table || (score(table) < 6 && !(ov.table && tables[ov.table]))) return null;
  const cols = tables[table];
  const lower = cols.map((c) => c.toLowerCase());
  const pick = (k) => { if (ov[k]) return cols.find((c) => c.toLowerCase() === String(ov[k]).toLowerCase()) || null; const g = GUESS[k].find((x) => lower.includes(x)); return g ? cols[lower.indexOf(g)] : null; };
  let options = null;
  if (Array.isArray(ov.options)) options = ov.options.map((o) => cols.find((c) => c.toLowerCase() === String(o).toLowerCase())).filter(Boolean);
  else if (typeof ov.options === 'string') options = pick('options');
  else { const set = OPTION_SETS.find((s) => s.every((c) => lower.includes(c))); options = set ? set.map((c) => cols[lower.indexOf(c)]) : pick('options'); }
  const m = { table, std: pick('std'), subject: pick('subject'), chapter: pick('chapter'), question: pick('question'), options, answer: pick('answer'), id: pick('id'), explanation: pick('explanation') };
  if (!m.std || !m.chapter || !m.question || !m.options || !m.answer || (Array.isArray(m.options) && m.options.length < 2)) return null;
  return m;
}

// "Class 9", "9th", "IX", 9, "09" -> 9
const ROMAN = { vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
function stdNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  const d = s.match(/\d+/);
  if (d) { const n = parseInt(d[0], 10); return n >= 1 && n <= 12 ? n : null; }
  const r = s.replace(/[^a-z]/g, '').replace(/^(class|std|standard|grade)/, '');
  return ROMAN[r] || null;
}

function splitOptions(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map((x) => String(x)); } catch (e) { /* fall through */ } }
  for (const sep of ['||', '|', '\n', ';;']) if (s.includes(sep)) return s.split(sep).map((x) => x.trim()).filter(Boolean);
  return s ? [s] : [];
}
// answer can be a letter (B), a number (1-based or 0-based), or the text of the right option
function answerIndex(raw, options, base) {
  if (raw === null || raw === undefined || raw === '') return -1;
  const s = String(raw).trim();
  const byText = options.findIndex((o) => String(o).trim().toLowerCase() === s.toLowerCase());
  if (byText >= 0 && !/^[a-d1-6]$/i.test(s)) return byText;
  const letter = s.match(/^\(?([a-f])\)?[.)]?$/i);
  if (letter) return letter[1].toLowerCase().charCodeAt(0) - 97;
  const n = Number(s);
  if (Number.isInteger(n)) { const i = n - base; return i >= 0 && i < options.length ? i : -1; }
  return byText;
}
function normalizeRow(row, m, base, n) {
  const options = Array.isArray(m.options) ? m.options.map((c) => (row[c] === null || row[c] === undefined ? '' : String(row[c]))).filter((x) => x !== '') : splitOptions(row[m.options]);
  const answer = answerIndex(row[m.answer], options, base);
  const question = String(row[m.question] || '').trim();
  if (!question || options.length < 2 || answer < 0) return null;
  const idn = m.id ? Number(row[m.id]) : NaN;
  return { id: Number.isFinite(idn) ? idn : n + 1, question, options, answer, byTeacher: false };
}

// ---------- live connection ----------
let client = null, map = null, base = 1, stdRaw = new Map();
let status = { enabled: !!process.env.TURSO_DATABASE_URL, ready: false, error: null, table: null, stds: [] };
const cache = new Map();
const TTL = 10 * 60 * 1000;
const cached = async (key, fn) => { const c = cache.get(key); if (c && Date.now() - c.at < TTL) return c.v; const v = await fn(); cache.set(key, { v, at: Date.now() }); return v; };

async function init() {
  if (!process.env.TURSO_DATABASE_URL) return status;
  try {
    const { createClient } = require('@libsql/client/web');
    client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    const t = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'");
    const tables = {};
    for (const r of t.rows) { const info = await client.execute('PRAGMA table_info(' + q(String(r.name)) + ')'); tables[r.name] = info.rows.map((c) => String(c.name)); }
    let override = null;
    if (process.env.TURSO_MAP) { try { override = JSON.parse(process.env.TURSO_MAP); } catch (e) { throw new Error('TURSO_MAP is not valid JSON'); } }
    map = detectMapping(tables, override);
    if (!map) throw new Error('Could not find the question table. Tables seen: ' + Object.keys(tables).join(', ') + '. Set TURSO_MAP (see README).');
    const d = await client.execute('SELECT DISTINCT ' + q(map.std) + ' AS v FROM ' + q(map.table));
    stdRaw = new Map();
    for (const r of d.rows) { const n = stdNumber(r.v); if (n && n >= 6) { if (!stdRaw.has(n)) stdRaw.set(n, []); stdRaw.get(n).push(r.v); } }
    base = 1;
    if (process.env.TURSO_ANSWER_BASE === '0' || process.env.TURSO_ANSWER_BASE === '1') base = Number(process.env.TURSO_ANSWER_BASE);
    else {
      try { const mm = await client.execute('SELECT MIN(CAST(' + q(map.answer) + ' AS INTEGER)) AS lo, COUNT(*) AS n FROM ' + q(map.table) + ' WHERE CAST(' + q(map.answer) + ' AS INTEGER) = ' + q(map.answer)); if (mm.rows[0] && mm.rows[0].n > 0 && Number(mm.rows[0].lo) === 0) base = 0; } catch (e) { /* letters or text answers: base is not used */ }
    }
    status = { enabled: true, ready: true, error: null, table: map.table, stds: [...stdRaw.keys()].sort((a, b) => a - b), mapping: map, answerBase: base };
  } catch (e) {
    status = { enabled: true, ready: false, error: e.message, table: null, stds: [] };
    console.error('Turso content not ready:', e.message);
  }
  return status;
}
let initP = null;
const ensure = () => (initP = initP || init());
const ready = () => status.ready;
const getStatus = () => ({ ...status, client: undefined });
const stds = () => status.stds || [];

const stdWhere = (std) => { const raws = stdRaw.get(std) || []; return { sql: raws.length ? q(map.std) + ' IN (' + raws.map(() => '?').join(',') + ')' : '0 = 1', args: raws }; };

// [{subject, chapter, n}] for one class
async function subjects(std) {
  return cached('subj:' + std, async () => {
    const w = stdWhere(std);
    const subj = map.subject ? q(map.subject) : "'General'";
    const r = await client.execute({ sql: 'SELECT ' + subj + ' AS subject, ' + q(map.chapter) + ' AS chapter, COUNT(*) AS n FROM ' + q(map.table) + ' WHERE ' + w.sql + ' GROUP BY 1, 2 ORDER BY 1, 2', args: w.args });
    return r.rows.map((x) => ({ subject: String(x.subject), chapter: String(x.chapter), n: Number(x.n) }));
  });
}
// all valid questions of one chapter
async function questions(std, subject, chapter) {
  return cached('q:' + std + '|' + subject + '|' + chapter, async () => {
    const w = stdWhere(std);
    const sql = 'SELECT * FROM ' + q(map.table) + ' WHERE ' + w.sql + (map.subject ? ' AND ' + q(map.subject) + ' = ?' : '') + ' AND ' + q(map.chapter) + ' = ?' + ' LIMIT 2000';
    const r = await client.execute({ sql, args: [...w.args, ...(map.subject ? [subject] : []), chapter] });
    return r.rows.map((row, i) => normalizeRow(row, map, base, i)).filter(Boolean);
  });
}
const clearCache = () => cache.clear();

module.exports = { init, ensure, ready, getStatus, stds, subjects, questions, clearCache, detectMapping, stdNumber, splitOptions, answerIndex, normalizeRow };
