'use strict';
// Finds image references in one line of text: data:image URIs, quoted strings ('...', "...", `...`, srcset lists),
// Markdown and CSS parentheses (![](...), url(...)), and bare tokens that end in an image extension
// (YAML, unquoted HTML attributes, plain text). Returns [{ start, end, raw, kind }] with columns in that line.
// kind: 'data', 'url' (Markdown, url(), src/href/srcset), 'string' (a quoted string in code) or 'bare'.

const EXT = 'png|apng|jpe?g|jpe|jfif|pjpeg|gif|webp|bmp|ico|cur|avif|heic|heif|tiff?|svg';
const IMG_END = new RegExp(`\\.(?:${EXT})(?:[?#][^\\s"'\`()<>]*)?$`, 'i');
const DATA_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[A-Za-z0-9+/=%._~!$&*:@-]*/gi;
const QUOTED_RE = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const PAREN_RE = /\((\s*)(<[^>\n]+>|[^()"'\s<>]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const BARE_RE = new RegExp(`(?:^|[\\s=:,\\[{>])((?:[~@./\\w-]|%20)[^\\s"'\`()<>,;=\\[\\]{}|*]*\\.(?:${EXT}))(?=$|[\\s"'\`)<>,;\\]}|?#])`, 'gi');
const URL_ATTR_RE = /(?:\b(?:src|href|srcset|poster|xlink:href|data-src|data-srcset|background|content)\s*=\s*$)|(?:url\(\s*$)/i;
const MAX_LINE = 20000;
const MAX_RAW = 2048;

const isImagePath = (s) => IMG_END.test(s) && s.length <= MAX_RAW && !/[*\n]/.test(s);

function add(out, start, raw, kind) {
  const end = start + raw.length;
  for (const r of out) if (start < r.end && end > r.start) return;
  out.push({ start, end, raw, kind });
}

/** Image references in one line. */
function findInLine(line) {
  const out = [];
  if (!line) return out;
  let m;
  QUOTED_RE.lastIndex = 0; // a data URI in quotes may hold spaces and the other quote kind (SVG text)
  while ((m = QUOTED_RE.exec(line))) if (/^data:image\//i.test(m[2])) add(out, m.index + 1, m[2], 'data');
  DATA_RE.lastIndex = 0;
  while ((m = DATA_RE.exec(line))) add(out, m.index, m[0], 'data');
  if (line.length > MAX_LINE) return out.sort((a, b) => a.start - b.start);
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(line))) {
    const body = m[2];
    const bodyStart = m.index + 1;
    if (!body || body.length > MAX_RAW * 4 || /^data:/i.test(body)) continue;
    const kind = URL_ATTR_RE.test(line.slice(Math.max(0, m.index - 24), m.index)) ? 'url' : 'string';
    const trimmed = body.trim();
    if (isImagePath(trimmed)) { add(out, bodyStart + body.indexOf(trimmed), trimmed, kind); continue; }
    if (/,/.test(body)) { // srcset: "a.png 1x, b.png 2x" or "a-400.jpg 400w, a-800.jpg 800w"
      const part = /([^\s,]+)(?:\s+[\d.]+[wx])?/g;
      let p;
      while ((p = part.exec(body))) if (isImagePath(p[1])) add(out, bodyStart + p.index, p[1], kind);
    }
  }
  PAREN_RE.lastIndex = 0;
  while ((m = PAREN_RE.exec(line))) {
    let raw = m[2];
    let start = m.index + 1 + m[1].length;
    if (raw.startsWith('<')) { raw = raw.slice(1, -1); start += 1; }
    if (isImagePath(raw) && !/^data:/i.test(raw)) add(out, start, raw, 'url');
  }
  BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(line))) {
    const raw = m[1];
    const start = m.index + m[0].length - raw.length;
    if (/^\.+$/.test(raw) || /^[\w-]+\/[\w.+-]+$/.test(raw) && /^image\//i.test(raw)) continue;
    add(out, start, raw, 'bare');
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every reference in a text: [{ line, start, end, raw, kind }]. Stops after max references. */
function findInText(text, max = 5000) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    for (const r of findInLine(lines[i])) { out.push(Object.assign({ line: i }, r)); if (out.length >= max) break; }
  }
  return out;
}

module.exports = { findInLine, findInText, isImagePath, EXT };
