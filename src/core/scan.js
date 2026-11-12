'use strict';
// The three Pro reports, as pure functions over file lists, so they are testable without VS Code:
// unused images, broken image references, and the image weight report. The extension reads the files.
const path = require('path');
const { findInText } = require('./refs');
const { looksLikePath } = require('./resolve');
const { humanSize } = require('./dims');

const IMAGE_GLOB_EXT = '{png,apng,jpg,jpeg,jpe,jfif,gif,webp,bmp,ico,cur,avif,heic,heif,tif,tiff,svg}';
const TEXT_GLOB_EXT = '{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro,css,scss,sass,less,styl,html,htm,xhtml,md,mdx,markdown,rst,txt,json,json5,jsonc,yml,yaml,toml,xml,svg,php,erb,ejs,hbs,handlebars,njk,liquid,pug,twig,jinja,j2,py,rb,go,java,kt,kts,swift,dart,cs,cshtml,razor,rs,ex,exs,elm,clj,cljs,webmanifest,plist,xib,storyboard,gradle,properties,ini,cfg,conf,csv,tsv,tex}';

/** Lower-case name and a few spellings code uses for it (URL-encoded, without the extension). */
function nameKeys(file) {
  const base = path.basename(file);
  const lower = base.toLowerCase();
  const keys = new Set([lower]);
  try { keys.add(encodeURI(base).toLowerCase()); keys.add(encodeURIComponent(base).toLowerCase()); } catch (e) { /* odd name */ }
  return { base, lower, keys: [...keys], stem: lower.replace(/\.[^.]+$/, '').replace(/@[23]x$/, '') };
}

/**
 * Images that no text file names. images: [abs path]; texts: [{ path, text }]; resolve(raw, docPath) -> result.
 * An image counts as used when a reference resolves to it, or when its file name (any case, or URL-encoded) appears
 * in any text file, or its name without the extension appears as a quoted string (icon names, require.context).
 * Returns { unused: [abs path], used: n }.
 */
function unusedImages(images, texts, resolve) {
  const used = new Set();
  const corpus = [];
  for (const t of texts) {
    const lower = String(t.text).toLowerCase();
    corpus.push(lower);
    if (resolve) for (const r of findInText(t.text, 20000)) { const x = resolve(r.raw, t.path); if (x && x.kind === 'file') used.add(path.resolve(x.path)); }
  }
  const all = corpus.join('\n\u0000\n');
  const unused = [];
  for (const img of images) {
    const abs = path.resolve(img);
    if (used.has(abs)) continue;
    const k = nameKeys(abs);
    if (k.keys.some((key) => all.includes(key))) continue;
    if (k.stem.length >= 3 && (all.includes(`'${k.stem}'`) || all.includes(`"${k.stem}"`) || all.includes(`\`${k.stem}\``) || all.includes(`/${k.stem}'`) || all.includes(`/${k.stem}"`))) continue;
    unused.push(abs);
  }
  return { unused, used: images.length - unused.length };
}

/** References that do not resolve and are meant as paths: [{ path, line, start, end, raw, kind }]. */
function brokenRefs(texts, resolve) {
  const out = [];
  for (const t of texts) {
    for (const r of findInText(t.text, 20000)) {
      if (r.kind === 'data') continue;
      const x = resolve(r.raw, t.path);
      if (x && x.kind === 'missing' && looksLikePath(r.raw, r.kind)) out.push(Object.assign({ path: t.path }, r));
    }
  }
  return out;
}

/**
 * infos: [{ path, size, width, height, type, alpha? }]. o: { maxKB (default 200), maxSide (default 2560) }.
 * Returns { rows (largest first, each with flags[]), total, byType, flagged }.
 */
function weightReport(infos, o = {}) {
  const maxBytes = (o.maxKB || 200) * 1024;
  const maxSide = o.maxSide || 2560;
  const rows = infos.map((i) => {
    const flags = [];
    if (i.size > maxBytes) flags.push(`over ${o.maxKB || 200} KB`);
    if (Math.max(i.width || 0, i.height || 0) > maxSide) flags.push(`wider or taller than ${maxSide} px`);
    if ((i.type === 'png' || i.type === 'bmp' || i.type === 'tiff') && i.size > 300 * 1024 && i.width * i.height > 250000 && !i.alpha) flags.push('photo-like image with no transparency: JPEG or WebP is usually much smaller');
    if (i.type === 'bmp' || i.type === 'tiff') flags.push(`${i.type.toUpperCase()} is not compressed for the web`);
    if (i.type === 'svg' && i.size > 100 * 1024) flags.push('SVG over 100 KB: it may hold an embedded bitmap or unoptimized paths');
    if (i.width && i.height && i.size / (i.width * i.height) > 2 && i.type === 'jpeg') flags.push('JPEG saved at a very high quality');
    return Object.assign({}, i, { flags });
  }).sort((a, b) => b.size - a.size);
  const byType = {};
  for (const r of rows) { const t = byType[r.type || 'other'] || (byType[r.type || 'other'] = { count: 0, size: 0 }); t.count++; t.size += r.size; }
  return { rows, total: rows.reduce((s, r) => s + r.size, 0), byType, flagged: rows.filter((r) => r.flags.length).length };
}

// ---------- Markdown reports ----------
const esc = (s) => String(s).replace(/([\\`*_[\]|<>])/g, '\\$1');
const link = (abs, rel, line) => `[${esc(rel)}${line ? `:${line}` : ''}](${encodeURI('file://' + abs.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:'))}${line ? `#L${line}` : ''})`;

function unusedMarkdown(res, o) {
  const { rel, sizes, scope, textCount } = o;
  const total = res.unused.reduce((s, p) => s + (sizes[p] || 0), 0);
  const lines = [`# Unused images in ${scope}`, '', `${res.unused.length} of ${res.unused.length + res.used} images are not named in any of the ${textCount} text files read (${humanSize(total)} in all).`, '',
    'An image counts as used when a path resolves to it or when its file name appears anywhere in code, styles, Markdown, HTML, JSON or YAML. Images that code builds from parts (`icons/${name}.svg`) or that a server loads by name may still be in use: check before you delete.', ''];
  if (res.unused.length) {
    lines.push('| Image | Size |', '|---|---:|');
    for (const p of res.unused.slice().sort((a, b) => (sizes[b] || 0) - (sizes[a] || 0))) lines.push(`| ${link(p, rel(p))} | ${humanSize(sizes[p] || 0)} |`);
  }
  return lines.join('\n') + '\n';
}

function brokenMarkdown(list, o) {
  const { rel, scope, textCount } = o;
  const files = new Set(list.map((b) => b.path));
  const lines = [`# Broken image references in ${scope}`, '', `${list.length} reference${list.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'} point to an image that does not exist (${textCount} text files read). They are also in the Problems panel.`, ''];
  let cur = '';
  for (const b of list) {
    if (b.path !== cur) { cur = b.path; lines.push('', `## ${esc(rel(b.path))}`, ''); }
    lines.push(`- ${link(b.path, rel(b.path), b.line + 1)} \`${b.raw.replace(/`/g, "'")}\``);
  }
  return lines.join('\n') + '\n';
}

function weightMarkdown(rep, o) {
  const { rel, scope, top = 100, maxKB = 200, maxSide = 2560 } = o;
  const lines = [`# Image weight report for ${scope}`, '', `${rep.rows.length} images, ${humanSize(rep.total)} in all. ${rep.flagged} flagged (limits: ${maxKB} KB, ${maxSide} px a side).`, '', '| Type | Images | Size |', '|---|---:|---:|'];
  for (const [t, v] of Object.entries(rep.byType).sort((a, b) => b[1].size - a[1].size)) lines.push(`| ${t.toUpperCase()} | ${v.count} | ${humanSize(v.size)} |`);
  lines.push('', `## Largest ${Math.min(top, rep.rows.length)}`, '', '| Image | Size | Pixels | Notes |', '|---|---:|---:|---|');
  for (const r of rep.rows.slice(0, top)) lines.push(`| ${link(r.path, rel(r.path))} | ${humanSize(r.size)} | ${r.width && r.height ? `${r.width} × ${r.height}` : '?'} | ${r.flags.map(esc).join('; ')} |`);
  const flagged = rep.rows.filter((r) => r.flags.length);
  if (flagged.length > top) { lines.push('', `## Other flagged images`, ''); for (const r of flagged.slice(top)) lines.push(`- ${link(r.path, rel(r.path))} ${humanSize(r.size)}: ${r.flags.map(esc).join('; ')}`); }
  return lines.join('\n') + '\n';
}

module.exports = { unusedImages, brokenRefs, weightReport, unusedMarkdown, brokenMarkdown, weightMarkdown, nameKeys, IMAGE_GLOB_EXT, TEXT_GLOB_EXT };
