// Class helpers used by server.js (teacher class control, who can see what).
// Class names look like "10", "10A", "11 B". A teacher's list is "10A,11":
//   "10A" = only division A of class 10, "11" = every division of class 11.

// "Class 10 - A" -> "10a"
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\b(class|std|standard)\b/g, '').replace(/[^a-z0-9]/g, '');

// "10A, 11" -> ["10a", "11"]  (unique, empty parts dropped)
const parseClasses = (s) => [...new Set(String(s == null ? '' : s).split(/[,;|\n]+/).map(norm).filter(Boolean))];

// "10a" -> { n: 10, d: "a" }   |   "11" -> { n: 11, d: "" }
const split = (s) => {
  const m = /^(\d+)([a-z]*)/.exec(norm(s));
  return m ? { n: parseInt(m[1], 10), d: m[2] } : { n: NaN, d: '' };
};

// class number only: "10A" -> 10 (null when there is none)
const classNum = (s) => { const n = split(s).n; return Number.isNaN(n) ? null : n; };

// the class + division of a person or item, e.g. ("10", "A") or ("10A", "")
const target = (cls, div) => {
  const t = split(cls);
  return { n: t.n, d: t.d || norm(div) };
};

// Is class `cls` / division `div` covered by the list `tokens` (e.g. ["10a","11"])?
// tokens === null  -> no limit (admin); tokens = [] -> nothing allowed.
function classAllowed(tokens, cls, div) {
  if (tokens === null || tokens === undefined) return true;
  const t = target(cls, div);
  if (Number.isNaN(t.n)) return false;
  return tokens.some((tok) => {
    const k = split(tok);
    return k.n === t.n && (k.d === '' || k.d === t.d);
  });
}

// Should a student of (stuCls, stuDiv) see something posted for (cls, div)? Empty target = everyone.
function studentSeesClass(stuCls, stuDiv, cls, div) {
  if (!norm(cls)) return true;
  const s = target(stuCls, stuDiv), t = target(cls, div);
  if (Number.isNaN(s.n) || Number.isNaN(t.n)) return false;
  return s.n === t.n && (t.d === '' || t.d === s.d);
}

module.exports = { norm, parseClasses, classAllowed, studentSeesClass, classNum };
