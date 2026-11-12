'use strict';
// Image type and pixel size from the first bytes of a file, without decoding pixels. PNG, APNG, JPEG, GIF, WebP,
// BMP, ICO/CUR, AVIF/HEIC (ispe box), TIFF and SVG (width, height or viewBox). Every read is bounds-checked and every
// loop has a cap, so a cut or hostile file gives null or a partial answer at once, never a throw.

const u16be = (b, o) => (o + 2 <= b.length ? (b[o] << 8) | b[o + 1] : -1);
const u32be = (b, o) => (o + 4 <= b.length ? b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] : -1);
const u16le = (b, o) => (o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : -1);
const u24le = (b, o) => (o + 3 <= b.length ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : -1);
const u32le = (b, o) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : -1);
const i32le = (b, o) => (o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : 0);
const ascii = (b, o, n) => (o >= 0 && o + n <= b.length ? String.fromCharCode(...b.subarray(o, o + n)) : '');

const TYPES = {
  png: { label: 'PNG', mime: 'image/png' }, apng: { label: 'APNG', mime: 'image/apng' }, jpeg: { label: 'JPEG', mime: 'image/jpeg' },
  gif: { label: 'GIF', mime: 'image/gif' }, webp: { label: 'WebP', mime: 'image/webp' }, bmp: { label: 'BMP', mime: 'image/bmp' },
  ico: { label: 'ICO', mime: 'image/x-icon' }, cur: { label: 'CUR', mime: 'image/x-icon' }, avif: { label: 'AVIF', mime: 'image/avif' },
  heic: { label: 'HEIC', mime: 'image/heic' }, tiff: { label: 'TIFF', mime: 'image/tiff' }, svg: { label: 'SVG', mime: 'image/svg+xml' },
};
// Types an Electron/Chromium <img> shows (hover and gutter). HEIC and TIFF are measured but not drawn.
const DRAWABLE = new Set(['png', 'apng', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'cur', 'avif', 'svg']);
const EXTENSIONS = ['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'gif', 'webp', 'bmp', 'ico', 'cur', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg'];

function hasTrns(b) {
  for (let off = 8, n = 0; off + 8 <= b.length && n < 64; n++) {
    const type = ascii(b, off + 4, 4);
    if (type === 'tRNS') return true;
    if (type === 'IDAT') return false;
    const len = u32be(b, off);
    if (len < 0) return false;
    off += 12 + len;
  }
  return false;
}

function png(b) {
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  let off = 8, n = 0, animated = false;
  while (off + 8 <= b.length && n++ < 64) { // acTL comes before the first IDAT
    const type = ascii(b, off + 4, 4);
    if (type === 'acTL') { animated = true; break; }
    if (type === 'IDAT') break;
    const len = u32be(b, off);
    if (len < 0) break;
    off += 12 + len;
  }
  return { type: animated ? 'apng' : 'png', width: u32be(b, 16), height: u32be(b, 20), animated, alpha: b[25] === 4 || b[25] === 6 || hasTrns(b), colorType: b[25] };
}

function jpeg(b) {
  let off = 2;
  for (let n = 0; off + 4 <= b.length && n < 100000; n++) {
    if (b[off] !== 0xff) { off++; continue; }
    const m = b[off + 1];
    if (m === 0xff) { off++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = u16be(b, off + 2);
    if (len < 2) break;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = u16be(b, off + 5), width = u16be(b, off + 7);
      return width > 0 && height > 0 ? { type: 'jpeg', width, height, progressive: m === 0xc2 } : null;
    }
    off += 2 + len;
  }
  return { type: 'jpeg', width: 0, height: 0, needMore: off >= b.length - 4 };
}

function gif(b) {
  if (b.length < 10) return null;
  return { type: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
}

function webp(b) {
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (kind === 'VP8L' && b[20] === 0x2f) { const v = u32le(b, 21); return { type: 'webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
  if (kind === 'VP8X' && b.length >= 30) return { type: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: !!(b[20] & 0x02) };
  return null;
}

function bmp(b) {
  if (b.length < 26) return null;
  const dib = u32le(b, 14);
  if (dib === 12) return { type: 'bmp', width: u16le(b, 18), height: u16le(b, 20) };
  if (dib < 40 || dib > 124) return null;
  return { type: 'bmp', width: i32le(b, 18), height: Math.abs(i32le(b, 22)) };
}

function ico(b) {
  const count = u16le(b, 4);
  if (count < 1 || count > 256) return null;
  let width = 0, height = 0;
  for (let i = 0; i < count; i++) { // the largest entry; 0 means 256
    const e = 6 + i * 16;
    if (e + 16 > b.length) break;
    const w = b[e] || 256, h = b[e + 1] || 256;
    if (w * h > width * height) { width = w; height = h; }
  }
  return width ? { type: b[2] === 2 ? 'cur' : 'ico', width, height, frames: count } : null;
}

// ISO BMFF (AVIF, HEIC): ftyp brand, then meta > iprp > ipco > ispe (image spatial extents).
function bmff(b) {
  const brand = ascii(b, 8, 4);
  const compat = ascii(b, 16, Math.max(0, Math.min(u32be(b, 0), 64) - 16));
  const isAvif = /avi[fs]/.test(brand + compat);
  const isHeic = /hei[cxms]|mif1|msf1|heix/.test(brand);
  if (!isAvif && !isHeic) return null;
  const type = isAvif ? 'avif' : 'heic';
  const lim = Math.min(b.length, 1 << 20);
  let best = null;
  for (let i = 4, n = 0; i + 16 <= lim && n < 200000; i++, n++) {
    if (b[i] === 0x69 && ascii(b, i, 4) === 'ispe') {
      const w = u32be(b, i + 8), h = u32be(b, i + 12);
      if (w > 0 && h > 0 && (!best || w * h > best.width * best.height)) best = { width: w, height: h };
    }
  }
  return { type, width: best ? best.width : 0, height: best ? best.height : 0 };
}

function tiff(b) {
  const le = b[0] === 0x49;
  const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? u32le(b, o) : u32be(b, o));
  const big = r16(2) === 43; // BigTIFF: 8-byte offsets and counts, 20-byte entries
  const r64 = (o) => { const lo = r32(le ? o : o + 4), hi = r32(le ? o + 4 : o); return lo < 0 || hi < 0 ? -1 : hi * 0x100000000 + lo; };
  const ifd = big ? r64(8) : r32(4);
  if (ifd < 8 || ifd + 2 > b.length) return { type: 'tiff', width: 0, height: 0, needMore: true };
  const n = big ? r64(ifd) : r16(ifd);
  let width = 0, height = 0;
  for (let i = 0; i < Math.min(n, 512); i++) {
    const e = big ? ifd + 8 + i * 20 : ifd + 2 + i * 12;
    if (e + (big ? 20 : 12) > b.length) break;
    const tag = r16(e), kind = r16(e + 2);
    const vo = big ? e + 12 : e + 8;
    const v = kind === 3 ? r16(vo) : kind === 16 ? r64(vo) : r32(vo);
    if (tag === 256) width = v;
    if (tag === 257) height = v;
  }
  return { type: 'tiff', width, height };
}

const UNIT = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };
function svgLength(v) {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i.exec(v || '');
  if (!m || m[2] === '%') return 0;
  return Math.round(parseFloat(m[1]) * (UNIT[(m[2] || 'px').toLowerCase()] || 1));
}
/** SVG size from the root element: width/height attributes, else the viewBox. */
function svg(text) {
  const s = String(text).replace(/<!--[\s\S]*?-->/g, '');
  const m = /<svg\b([^>]*)>/i.exec(s);
  if (!m) return null;
  const attr = (n) => { const r = new RegExp(`(?:^|\\s)${n}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(m[1]); return r ? r[2] : ''; };
  let width = svgLength(attr('width')), height = svgLength(attr('height'));
  const vb = attr('viewBox').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (!width && !height) { width = Math.round(vb[2]); height = Math.round(vb[3]); }
    else if (!width) width = Math.round((height * vb[2]) / vb[3]);
    else if (!height) height = Math.round((width * vb[3]) / vb[2]);
  }
  return { type: 'svg', width, height, viewBox: vb.length === 4 ? vb.join(' ') : '' };
}

/** { type, label, mime, width, height, animated? } or null when the bytes are not an image this module knows. */
function probe(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let r = null;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') r = png(b);
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) r = jpeg(b);
  else if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') r = gif(b);
  else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') r = webp(b);
  else if (b[0] === 0x42 && b[1] === 0x4d) r = bmp(b);
  else if (b.length >= 22 && u16le(b, 0) === 0 && (u16le(b, 2) === 1 || u16le(b, 2) === 2)) r = ico(b);
  else if (ascii(b, 4, 4) === 'ftyp') r = bmff(b);
  else if (['II*\0', 'MM\0*', 'II+\0', 'MM\0+'].includes(ascii(b, 0, 4))) r = tiff(b);
  else {
    const head = Buffer.from(b.subarray(0, Math.min(b.length, 4096))).toString('utf8').replace(/^﻿/, '');
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head) || /<svg[\s>]/i.test(head)) r = svg(Buffer.from(b).toString('utf8'));
  }
  if (!r) return null;
  if (!(r.width > 0)) r.width = 0;
  if (!(r.height > 0)) r.height = 0;
  return Object.assign(r, TYPES[r.type]);
}

function typeFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const e = m ? m[1].toLowerCase() : '';
  return ({ jpg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg', pjpeg: 'jpeg', heif: 'heic', tif: 'tiff' })[e] || (TYPES[e] ? e : '');
}

function humanSize(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

module.exports = { probe, svg, svgLength, typeFromName, humanSize, TYPES, DRAWABLE, EXTENSIONS };
