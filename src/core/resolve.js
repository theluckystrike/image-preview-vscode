'use strict';
// Turns the text of an image reference into a local file, a remote URL (never fetched), a data URI, or "missing".
// Tries, in order: absolute paths and file:// URIs, tsconfig/jsconfig "paths" and baseUrl, the user's aliases,
// ~ (home or node_modules) and @/ (src), paths from the file's folder, and paths from the workspace root and its
// public/static/src/assets folders (also for each parent folder, for monorepos). Spaces, %20 and ?query/#hash work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const DEFAULT_PUBLIC = ['public', 'static', 'src', 'assets', 'app', 'www', 'wwwroot', 'docs'];

/** JSON with comments and trailing commas (tsconfig.json, jsconfig.json). null when it does not parse. */
function parseJsonc(text) {
  let out = '', i = 0, inStr = false;
  const s = String(text).replace(/^﻿/, '');
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    out += c; i++;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { return null; }
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }

/** Loads compilerOptions.baseUrl and paths of one tsconfig/jsconfig, following relative "extends" (3 levels). */
function loadTsConfig(file, readFile = (f) => fs.readFileSync(f, 'utf8'), depth = 0) {
  let j;
  try { j = parseJsonc(readFile(file)); } catch (e) { j = null; }
  if (!j || typeof j !== 'object') return null;
  const dir = path.dirname(file);
  let base = { baseUrl: '', paths: [] };
  const ext = typeof j.extends === 'string' ? j.extends : Array.isArray(j.extends) ? j.extends[0] : '';
  if (ext && depth < 3 && /^\.{1,2}[\\/]/.test(ext)) {
    const f = path.resolve(dir, /\.json$/i.test(ext) ? ext : ext + '.json');
    base = loadTsConfig(f, readFile, depth + 1) || base;
  }
  const co = j.compilerOptions || {};
  const baseUrl = typeof co.baseUrl === 'string' ? path.resolve(dir, co.baseUrl) : base.baseUrl;
  let paths = base.paths;
  if (co.paths && typeof co.paths === 'object') {
    const root = baseUrl || dir; // TypeScript 4.1+: paths without baseUrl are relative to the tsconfig file
    paths = Object.entries(co.paths).filter(([, t]) => Array.isArray(t)).map(([pattern, targets]) => ({ pattern, targets: targets.filter((x) => typeof x === 'string').map((x) => path.resolve(root, x)) }));
  }
  return { file, baseUrl, paths };
}

/** Applies tsconfig paths patterns ("@/*" -> ["src/*"]) to a specifier. Returns candidate absolute paths. */
function applyPaths(spec, paths) {
  const out = [];
  for (const { pattern, targets } of paths || []) {
    const star = pattern.indexOf('*');
    if (star < 0) { if (spec === pattern) out.push(...targets); continue; }
    const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
    if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) {
      const mid = spec.slice(pre.length, spec.length - post.length);
      for (const t of targets) out.push(t.replace('*', mid));
    }
  }
  return out;
}

function within(p, roots) { return roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep)); }

/**
 * Creates a resolver. o: { roots: [abs workspace folders], aliases: { '@': 'src', ... } (relative to the first root
 * or absolute), publicDirs, home, exists(p): bool, readFile(p): string, byName(name, docDir): abs path or null
 * (a plain file name that is found nowhere else, looked up in an index of the workspace images) }.
 */
function createResolver(o = {}) {
  const roots = (o.roots || []).map((r) => path.resolve(r));
  const exists = o.exists || isFile;
  const readFile = o.readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const home = o.home || os.homedir();
  const publicDirs = o.publicDirs || DEFAULT_PUBLIC;
  const aliases = Object.entries(o.aliases || {}).filter(([k, v]) => k && typeof v === 'string');
  const tsCache = new Map(); // dir -> config or null

  /** The workspace roots that hold dir, or [] when dir is outside every root (then at most 8 levels up). */
  const scopeOf = (dir) => roots.filter((r) => within(dir, [r]));

  function tsConfigFor(dir) {
    const chain = [];
    const scope = scopeOf(dir);
    let d = dir;
    for (let i = 0; i < (scope.length ? 40 : 8); i++) {
      if (tsCache.has(d)) { const c = tsCache.get(d); for (const x of chain) tsCache.set(x, c); return c; }
      chain.push(d);
      for (const n of ['tsconfig.json', 'jsconfig.json']) {
        const f = path.join(d, n);
        if (exists(f)) { const c = loadTsConfig(f, readFile); for (const x of chain) tsCache.set(x, c); return c; }
      }
      const up = path.dirname(d);
      if (up === d || (scope.length && !within(up, scope))) break;
      d = up;
    }
    for (const x of chain) tsCache.set(x, null);
    return null;
  }

  /** Folders from the document's folder up to its workspace root (inclusive), nearest first. */
  function ancestors(dir) {
    const out = [];
    const scope = scopeOf(dir);
    let d = dir;
    for (let i = 0; i < (scope.length ? 40 : 8) && d; i++) {
      out.push(d);
      if (roots.includes(d)) break;
      const up = path.dirname(d);
      if (up === d || (scope.length && !within(up, scope))) break;
      d = up;
    }
    return out;
  }

  /**
   * raw: the reference text. docPath: absolute path of the file it is in ('' for untitled).
   * Returns { kind: 'file', path } | { kind: 'remote', url } | { kind: 'data', mime, base64, payload } |
   *         { kind: 'dynamic' } | { kind: 'other' } | { kind: 'missing', spec, tried }.
   */
  function resolve(raw, docPath) {
    let s = String(raw || '').trim();
    if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
    if (!s) return { kind: 'other' };
    const dm = /^data:(image\/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*?)(;base64)?,(.*)$/is.exec(s);
    if (dm) return { kind: 'data', mime: dm[1].toLowerCase(), base64: !!dm[3], payload: dm[4] };
    if (/^(https?:)?\/\//i.test(s)) return { kind: 'remote', url: s.startsWith('//') ? 'https:' + s : s };
    if (/\$\{|\{\{|<%|#\{|\$\(|\[\[/.test(s)) return { kind: 'dynamic' };
    if (/^file:\/\//i.test(s)) { try { const p = fileURLToPath(s.replace(/[?#].*$/, '')); return exists(p) ? { kind: 'file', path: p } : { kind: 'missing', spec: s, tried: [p] }; } catch (e) { return { kind: 'other' }; } }
    if (/^[a-z][a-z0-9+.-]+:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) return { kind: 'other' };
    const docDir = docPath ? path.dirname(docPath) : (roots[0] || '');
    const specs = [];
    const bare = s.replace(/[?#].*$/, '');
    for (const v of [bare, s]) {
      if (!specs.includes(v)) specs.push(v);
      if (/%[0-9a-f]{2}/i.test(v)) { try { const d = decodeURIComponent(v); if (!specs.includes(d)) specs.push(d); } catch (e) { /* keep raw */ } }
      if (/\\ /.test(v)) specs.push(v.replace(/\\ /g, ' '));
    }
    const tried = [];
    const tryP = (p) => { if (!p) return null; const n = path.normalize(p); if (tried.includes(n)) return null; tried.push(n); return exists(n) ? n : null; };
    const rootFor = (roots.find((r) => docPath && within(docPath, roots) && within(docPath, [r])) || roots[0] || docDir);
    for (const spec of specs) {
      let hit;
      if (path.isAbsolute(spec) && !spec.startsWith('/')) { if ((hit = tryP(spec))) return { kind: 'file', path: hit }; }
      const ts = docDir ? tsConfigFor(docDir) : null;
      const relative = /^\.{1,2}[\\/]/.test(spec) || spec === '.' || spec === '..';
      if (!relative) {
        if (ts) {
          for (const c of applyPaths(spec, ts.paths)) if ((hit = tryP(c))) return { kind: 'file', path: hit };
          if (ts.baseUrl && !spec.startsWith('/') && (hit = tryP(path.join(ts.baseUrl, spec)))) return { kind: 'file', path: hit };
        }
        for (const [k, v] of aliases) {
          if (spec === k || spec.startsWith(k.endsWith('/') ? k : k + '/')) {
            const target = path.isAbsolute(v) ? v : path.join(rootFor || '', v);
            if ((hit = tryP(path.join(target, spec.slice(k.length))))) return { kind: 'file', path: hit };
          }
        }
        if (spec.startsWith('~/')) {
          if ((hit = tryP(path.join(home, spec.slice(2))))) return { kind: 'file', path: hit };
          for (const a of ancestors(docDir)) if ((hit = tryP(path.join(a, 'src', spec.slice(2)))) || (hit = tryP(path.join(a, spec.slice(2))))) return { kind: 'file', path: hit };
        } else if (spec.startsWith('~')) {
          for (const a of ancestors(docDir)) if ((hit = tryP(path.join(a, 'node_modules', spec.slice(1))))) return { kind: 'file', path: hit };
        }
        if (spec.startsWith('@/') || spec.startsWith('@@/')) {
          const rest = spec.replace(/^@@?\//, '');
          for (const a of ancestors(docDir)) if ((hit = tryP(path.join(a, 'src', rest))) || (spec.startsWith('@@/') && (hit = tryP(path.join(a, rest))))) return { kind: 'file', path: hit };
        }
      }
      if (spec.startsWith('/')) {
        if ((hit = tryP(spec)) && (within(hit, roots) || !roots.length || exists(spec))) return { kind: 'file', path: hit };
        for (const a of ancestors(docDir)) {
          if ((hit = tryP(path.join(a, spec)))) return { kind: 'file', path: hit };
          for (const pd of publicDirs) if ((hit = tryP(path.join(a, pd, spec)))) return { kind: 'file', path: hit };
        }
        for (const r of roots) {
          if ((hit = tryP(path.join(r, spec)))) return { kind: 'file', path: hit };
          for (const pd of publicDirs) if ((hit = tryP(path.join(r, pd, spec)))) return { kind: 'file', path: hit };
        }
        continue;
      }
      if (/^[a-z]:[\\/]/i.test(spec)) { if ((hit = tryP(spec))) return { kind: 'file', path: hit }; continue; }
      if (docDir && (hit = tryP(path.resolve(docDir, spec)))) return { kind: 'file', path: hit };
      if (!relative && !spec.startsWith('~') && !spec.startsWith('@')) {
        for (const a of ancestors(docDir).slice(1)) if ((hit = tryP(path.join(a, spec)))) return { kind: 'file', path: hit };
        for (const a of ancestors(docDir)) for (const pd of publicDirs) if ((hit = tryP(path.join(a, pd, spec)))) return { kind: 'file', path: hit };
        for (const a of ancestors(docDir)) if ((hit = tryP(path.join(a, 'node_modules', spec)))) return { kind: 'file', path: hit };
      }
    }
    if (o.byName && !/[\\/]/.test(specs[specs.length - 1]) && docDir) {
      const hit = o.byName(specs[specs.length - 1], docDir);
      if (hit) return { kind: 'file', path: hit, byName: true };
    }
    return { kind: 'missing', spec: specs[specs.length > 1 && /%[0-9a-f]{2}/i.test(bare) ? 1 : 0], tried };
  }

  return { resolve, tsConfigFor, clear: () => tsCache.clear() };
}

/** Decodes a data:image payload. Returns a Buffer, or null when it is larger than max bytes or broken. */
function decodeData(r, max = 1024 * 1024) {
  if (!r || r.kind !== 'data') return null;
  try {
    if (r.base64) {
      const clean = r.payload.replace(/%[0-9a-f]{2}/gi, (m) => decodeURIComponent(m)).replace(/\s+/g, '');
      if (clean.length * 0.75 > max) return null;
      return Buffer.from(clean, 'base64');
    }
    const text = decodeURIComponent(r.payload);
    return text.length > max ? null : Buffer.from(text, 'utf8');
  } catch (e) { return null; }
}

/** True when a missing reference is meant as a path (worth a "broken" report), not a name in data. */
function looksLikePath(raw, kind) {
  const s = String(raw).trim();
  if (kind === 'data') return false;
  if (kind === 'url') return true;
  if (kind === 'bare') return /^(\.{1,2}\/|\/|~\/|@\/)/.test(s);
  return /^(\.{1,2}[\\/]|\/(?!\/)|~|@\/)/.test(s) || s.includes('/');
}

module.exports = { createResolver, parseJsonc, loadTsConfig, applyPaths, decodeData, looksLikePath, DEFAULT_PUBLIC };
