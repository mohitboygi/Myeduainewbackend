const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\b(class|std|standard)\b/g, '').replace(/[^a-z0-9]/g, '');
const parseClasses = (s) => [...new Set(String(s == null ? '' : s).split(/[,;|\n]+/).map(norm).filter(Boolean))];
const split = (s) => {
  const m = /^(\d+)([a-z]*)/.exec(norm(s));
  return m ? { n: parseInt(m[1], 10), d: m[2] } : { n: NaN, d: '' };
};
const classNum = (s) => { const n = split(s).n; return Number.isNaN(n) ? null : n; };
const target = (cls, div) => {
  const t = split(cls);
  return { n: t.n, d: t.d || norm(div) };
};
function classAllowed(tokens, cls, div) {
  if (tokens === null || tokens === undefined) return true;
  const t = target(cls, div);
  if (Number.isNaN(t.n)) return false;
  return tokens.some((tok) => {
    const k = split(tok);
    return k.n === t.n && (k.d === '' || k.d === t.d);
  });
}
function studentSeesClass(stuCls, stuDiv, cls, div) {
  if (!norm(cls)) return true;
  const s = target(stuCls, stuDiv), t = target(cls, div);
  if (Number.isNaN(s.n) || Number.isNaN(t.n)) return false;
  return s.n === t.n && (t.d === '' || t.d === s.d);
}
module.exports = { norm, parseClasses, classAllowed, studentSeesClass, classNum };
