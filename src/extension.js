'use strict';
// Image Preview & Image Hover by Zovo. Free core: a gutter thumbnail next to each line that names an image, and a hover
// with the image, its type, pixel size and file size. Paths are found in code strings, imports, CSS url(), Markdown,
// HTML src/srcset, YAML and plain text, and data:image URIs. Local files only: remote URLs are shown as links and
// never fetched. No network and no telemetry. Nothing shows on activation. Pro tools (pro.js) ask only when used.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dims = require('./core/dims');
const refs = require('./core/refs');
const { createResolver, decodeData, DEFAULT_PUBLIC } = require('./core/resolve');
const scan = require('./core/scan');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const EXT_ID = 'zovo.zovo-image-preview';
const PREFIX = 'imgPreview';
const MAX_DOC_CHARS = 5 * 1024 * 1024;
const MAX_REFS_PER_DOC = 2000;
const MAX_DATA_BYTES = 1024 * 1024;
const PROBE_BYTES = 512 * 1024;

let rating = { success() {}, failure() {} };
let pro, reach, ctxRef, diags, resolver, cacheDir;
const gutterTypes = new Map(); // icon path -> decoration type
const editorTypes = new WeakMap(); // editor -> Set of types it shows
const infoCache = new Map(); // path -> { key, info }
const counted = new Set();
const timers = new Map();
let nameIndex = null; // { state, byName: Map(lower name -> [abs]) }

function setting(key, dflt) { try { const v = vscode.workspace.getConfiguration(PREFIX).get(key, dflt); return v === undefined ? dflt : v; } catch (e) { return dflt; } }
const roots = () => (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
const isSample = (uri) => ctxRef && uri && uri.scheme === 'file' && uri.fsPath.startsWith(ctxRef.extensionUri.fsPath);
const docPath = (doc) => (doc.uri.scheme === 'file' ? doc.uri.fsPath : '');
const relPath = (p) => { for (const r of roots()) if (p.startsWith(r + path.sep)) return path.relative(r, p).split(path.sep).join('/'); return p; };

function makeResolver() {
  resolver = createResolver({ roots: roots(), aliases: setting('aliases', {}) || {}, publicDirs: setting('publicFolders', DEFAULT_PUBLIC) || DEFAULT_PUBLIC, byName });
  return resolver;
}

/** A plain name such as "beans.jpg" that is found nowhere else: the nearest workspace image with that name. */
function byName(name, docDir) {
  if (!nameIndex || nameIndex.state !== 'ready') { buildNameIndex(); return null; }
  const list = nameIndex.byName.get(String(name).toLowerCase());
  if (!list || !list.length) return null;
  let best = null, bestScore = -1;
  for (const p of list) { // the candidate that shares the longest folder prefix with the document
    let i = 0; const a = path.dirname(p); while (i < a.length && i < docDir.length && a[i] === docDir[i]) i++;
    if (i > bestScore) { best = p; bestScore = i; }
  }
  return bestScore > 1 ? best : null;
}
function buildNameIndex() {
  if (nameIndex || !vscode.workspace.findFiles || !roots().length) return;
  nameIndex = { state: 'building', byName: new Map() };
  Promise.resolve(vscode.workspace.findFiles(`**/*.${scan.IMAGE_GLOB_EXT}`, setting('exclude', ''), 20000)).then((uris) => {
    for (const u of uris || []) { if (u.scheme !== 'file') continue; const k = path.basename(u.fsPath).toLowerCase(); const l = nameIndex.byName.get(k) || []; l.push(u.fsPath); nameIndex.byName.set(k, l); }
    nameIndex.state = 'ready';
    if (resolver) resolver.clear();
    refreshAll();
  }, () => { nameIndex.state = 'ready'; });
}

/** Type, pixel size and file size of a local image (cached by size and mtime). null when it is not a file. */
function fileInfo(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  if (!st.isFile()) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const c = infoCache.get(p);
  if (c && c.key === key) return c.info;
  let info = null;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const n = Math.min(st.size, PROBE_BYTES);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, 0);
      info = dims.probe(buf);
      if (info && info.needMore && st.size > n) { // a JPEG with a large EXIF block before its size marker
        const m = Math.min(st.size, 8 * 1024 * 1024);
        const big = Buffer.alloc(m);
        fs.readSync(fd, big, 0, m, 0);
        info = dims.probe(big) || info;
      }
    } finally { fs.closeSync(fd); }
  } catch (e) { info = null; }
  const type = (info && info.type) || dims.typeFromName(p);
  const res = { path: p, size: st.size, mtime: st.mtimeMs, type, label: info ? info.label : (dims.TYPES[type] || {}).label || 'File', width: info ? info.width : 0, height: info ? info.height : 0, animated: !!(info && info.animated), alpha: !!(info && info.alpha), known: !!info };
  infoCache.set(p, { key, info: res });
  if (infoCache.size > 3000) infoCache.delete(infoCache.keys().next().value);
  return res;
}

/** A data:image URI written once to the extension's cache folder (gutter icons need a file). */
function dataFile(r) {
  const buf = decodeData(r, MAX_DATA_BYTES);
  if (!buf || !buf.length || !cacheDir) return null;
  const info = dims.probe(buf);
  if (!info || !dims.DRAWABLE.has(info.type)) return null;
  const ext = info.type === 'jpeg' ? 'jpg' : info.type === 'apng' ? 'png' : info.type;
  const p = path.join(cacheDir, crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + ext);
  try { if (!fs.existsSync(p)) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(p, buf); } } catch (e) { return null; }
  return { path: p, info, bytes: buf.length };
}

function drawable(info) {
  return info && dims.DRAWABLE.has(info.type) && info.size <= setting('maxFileSizeMB', 20) * 1024 * 1024;
}

function gutterType(iconPath) {
  let t = gutterTypes.get(iconPath);
  if (!t) {
    t = vscode.window.createTextEditorDecorationType({ gutterIconPath: vscode.Uri.file(iconPath), gutterIconSize: 'contain' });
    gutterTypes.set(iconPath, t);
  }
  return t;
}

/** The icon to draw for one reference, or null. */
function iconFor(ref, doc) {
  const r = resolver.resolve(ref.raw, docPath(doc));
  if (r.kind === 'file') { const info = fileInfo(r.path); return drawable(info) ? r.path : null; }
  if (r.kind === 'data') { const d = dataFile(r); return d ? d.path : null; }
  return null;
}

function isTarget(doc) {
  return doc && (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') && !/^(git|output|vscode-|search-editor)/.test(doc.uri.scheme) && doc.languageId !== 'Log';
}

function updateEditor(ed) {
  if (!ed || !ed.document) return;
  const prev = editorTypes.get(ed) || new Set();
  const next = new Map(); // type -> ranges
  const doc = ed.document;
  let found = 0;
  if (setting('gutter', true) && isTarget(doc) && doc.getText().length <= MAX_DOC_CHARS) {
    if (!resolver) makeResolver();
    const all = refs.findInText(doc.getText(), MAX_REFS_PER_DOC);
    const lineDone = new Set();
    for (const ref of all) {
      if (lineDone.has(ref.line)) continue;
      const icon = iconFor(ref, doc);
      if (!icon) continue;
      lineDone.add(ref.line);
      found++;
      const t = gutterType(icon);
      if (!next.has(t)) next.set(t, []);
      next.get(t).push(new vscode.Range(ref.line, 0, ref.line, 0));
    }
  }
  for (const t of prev) if (!next.has(t)) ed.setDecorations(t, []);
  for (const [t, ranges] of next) ed.setDecorations(t, ranges);
  editorTypes.set(ed, new Set(next.keys()));
  if (found && doc.uri.scheme === 'file' && !isSample(doc.uri)) {
    const k = doc.uri.toString();
    if (!counted.has(k)) { counted.add(k); rating.success(doc.uri); }
  }
}

function pruneTypes() {
  const live = new Set();
  for (const ed of vscode.window.visibleTextEditors) for (const t of editorTypes.get(ed) || []) live.add(t);
  if (gutterTypes.size < 300) return;
  for (const [k, t] of gutterTypes) if (!live.has(t)) { t.dispose(); gutterTypes.delete(k); }
}

function refreshAll() {
  for (const ed of vscode.window.visibleTextEditors) updateEditor(ed);
  pruneTypes();
}

function schedule(doc) {
  const k = doc.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) updateEditor(ed); }, 300));
}

// ---------------- hover ----------------
/** The small Rate · More free viewers · Zovo Pro line under a file hover (setting imgPreview.showSupportLinks). */
function footerLinks() {
  let f = '';
  try { f = support.footerMarkdown(PREFIX); } catch (e) { return ''; }
  // CARD2: tag a card checkout from this link as "footer".
  return f.replace(`(command:${PREFIX}.getPro)`, `(command:${PREFIX}.getPro?${encodeURIComponent(JSON.stringify(['footer']))})`);
}
function fitSize(w, h, max) {
  if (!(w > 0 && h > 0)) return { w: max, h: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
const mdEsc = (s) => String(s).replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1');
const cmdLink = (cmd, args) => `command:${cmd}?${encodeURIComponent(JSON.stringify(args))}`;

function describe(info, extra) {
  const parts = [`**${info.label}${info.animated ? ' (animated)' : ''}**`];
  if (info.width && info.height) parts.push(`${info.width} × ${info.height} px`);
  if (info.size >= 0) parts.push(dims.humanSize(info.size));
  if (info.alpha) parts.push('transparent');
  if (extra) parts.push(extra);
  return parts.join(' · ');
}

function imageMd(src, info, max) {
  const f = fitSize(info.width, info.height, max);
  return `![image](${src}|width=${f.w}${f.h ? `,height=${f.h}` : ''})`;
}

function provideHover(doc, pos) {
  if (!setting('hover', true) || !isTarget(doc)) return undefined;
  const line = doc.lineAt(pos.line).text;
  const ref = refs.findInLine(line).find((r) => pos.character >= r.start && pos.character <= r.end);
  if (!ref) return undefined;
  if (!resolver) makeResolver();
  const r = resolver.resolve(ref.raw, docPath(doc));
  const max = setting('hoverMaxSize', 220);
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = false;
  const range = new vscode.Range(pos.line, ref.start, pos.line, ref.end);
  if (r.kind === 'file') {
    const info = fileInfo(r.path);
    if (!info) return undefined;
    const uri = vscode.Uri.file(r.path);
    if (drawable(info)) md.appendMarkdown(imageMd(uri.toString(), info, max) + '\n\n');
    else if (!dims.DRAWABLE.has(info.type)) md.appendMarkdown(`*VS Code cannot draw ${info.label} files; the size comes from the file header.*\n\n`);
    else md.appendMarkdown(`*Larger than ${setting('maxFileSizeMB', 20)} MB, so it is not drawn (setting imgPreview.maxFileSizeMB).*\n\n`);
    md.appendMarkdown(describe(info, info.known ? '' : 'header not read') + '\n\n');
    md.appendMarkdown(`\`${relPath(r.path).replace(/`/g, "'")}\`${r.byName ? ' (found by its file name)' : ''} · [Open](${cmdLink('vscode.open', [uri])}) · [Show in Explorer](${cmdLink('revealInExplorer', [uri])})`);
    if (setting('showSupportLinks', true) !== false) md.appendMarkdown('\n\n---\n\n' + footerLinks());
    return new vscode.Hover(md, range);
  }
  if (r.kind === 'data') {
    const buf = decodeData(r, MAX_DATA_BYTES);
    const info = buf ? dims.probe(buf) : null;
    if (!info) { md.appendMarkdown(buf ? `data URI (${r.mime}) that is not a readable image.` : `data URI larger than ${dims.humanSize(MAX_DATA_BYTES)}, not decoded.`); return new vscode.Hover(md, range); }
    const full = Object.assign({}, info, { size: buf.length });
    const d = dims.DRAWABLE.has(info.type) ? dataFile(r) : null;
    if (d) md.appendMarkdown(imageMd(vscode.Uri.file(d.path).toString(), full, max) + '\n\n');
    md.appendMarkdown(describe(full, `data URI${r.base64 ? ', base64' : ''}, ${dims.humanSize(ref.raw.length)} of text`));
    return new vscode.Hover(md, range);
  }
  if (r.kind === 'remote') {
    md.appendMarkdown(`Remote image, not loaded (this extension never downloads anything): [${mdEsc(r.url.length > 80 ? r.url.slice(0, 77) + '...' : r.url)}](${r.url.replace(/\)/g, '%29')})`);
    return new vscode.Hover(md, range);
  }
  if (r.kind === 'missing') {
    md.appendMarkdown(`**Image not found:** \`${String(r.spec).replace(/`/g, "'")}\``);
    const shown = (r.tried || []).slice(0, 3).map((p) => `\`${relPath(p).replace(/`/g, "'")}\``);
    if (shown.length) md.appendMarkdown(`\n\nLooked for ${shown.join(', ')}${r.tried.length > 3 ? ` and ${r.tried.length - 3} more` : ''}. Path prefixes go in the setting imgPreview.aliases.`);
    return new vscode.Hover(md, range);
  }
  if (r.kind === 'dynamic') {
    md.appendMarkdown('This path is built when the code runs, so it cannot be previewed.');
    return new vscode.Hover(md, range);
  }
  return undefined;
}

// ---------------- Pro tools ----------------
async function pickScope(uri) {
  if (uri && uri.scheme === 'file') {
    let isDir = false;
    try { isDir = fs.statSync(uri.fsPath).isDirectory(); } catch (e) { isDir = false; }
    const dir = isDir ? uri.fsPath : path.dirname(uri.fsPath);
    const root = roots().find((r) => dir === r || dir.startsWith(r + path.sep)) || dir;
    return { dir, root };
  }
  const rs = roots();
  if (!rs.length) { vscode.window.showInformationMessage('Open a folder first: the Pro tools read the images and files of a workspace folder.'); return null; }
  if (rs.length === 1) return { dir: rs[0], root: rs[0] };
  const p = await vscode.window.showQuickPick(rs.map((r) => ({ label: path.basename(r), description: r, r })), { title: 'Which workspace folder?' });
  return p ? { dir: p.r, root: p.r } : null;
}

async function listFiles(dir, ext, token) {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), `**/*.${ext}`), setting('exclude', '') || null, 20000, token);
  return uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath).filter((p) => !p.includes(`${path.sep}${setting('archiveFolder', '_unused-images')}${path.sep}`));
}

async function readTexts(files, token) {
  const out = [];
  for (const f of files) {
    if (token && token.isCancellationRequested) break;
    try { const st = fs.statSync(f); if (st.size > 2 * 1024 * 1024) continue; out.push({ path: f, text: await fs.promises.readFile(f, 'utf8') }); } catch (e) { /* skip unreadable */ }
  }
  return out;
}

async function openReport(text) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

function progress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (p, token) => fn(token));
}

async function findUnused(uri) {
  if (!(await pro.allowed('unused'))) return;
  const scope = await pickScope(uri);
  if (!scope) return;
  makeResolver();
  const res = await progress('Finding unused images...', async (token) => {
    const images = await listFiles(scope.dir, scan.IMAGE_GLOB_EXT, token);
    const texts = await readTexts(await listFiles(scope.root, scan.TEXT_GLOB_EXT, token), token);
    if (token.isCancellationRequested) return null;
    // An SVG file is also text that can name other images, but it does not make itself used.
    const r = scan.unusedImages(images, texts, (raw, p) => resolver.resolve(raw, p));
    return { r, images, texts };
  });
  if (!res) return;
  const sizes = {};
  for (const p of res.r.unused) { try { sizes[p] = fs.statSync(p).size; } catch (e) { sizes[p] = 0; } }
  await openReport(scan.unusedMarkdown(res.r, { rel: relPath, sizes, scope: relPath(scope.dir) === scope.dir ? path.basename(scope.dir) : relPath(scope.dir) || path.basename(scope.dir), textCount: res.texts.length }));
  await pro.produced('unused');
  refreshPro();
  if (!res.r.unused.length) return;
  const folder = setting('archiveFolder', '_unused-images');
  const move = `Move ${res.r.unused.length} to ${folder}`;
  const a = await vscode.window.showWarningMessage(`${res.r.unused.length} image${res.r.unused.length === 1 ? ' is' : 's are'} not named in any file. Move ${res.r.unused.length === 1 ? 'it' : 'them'} to the folder "${folder}"? Edit > Undo moves them back.`, { modal: true }, move);
  if (a !== move) return;
  const we = new vscode.WorkspaceEdit();
  for (const p of res.r.unused) {
    const target = path.join(scope.root, folder, path.relative(scope.root, p));
    we.renameFile(vscode.Uri.file(p), vscode.Uri.file(target), { overwrite: false, ignoreIfExists: true });
  }
  const ok = await vscode.workspace.applyEdit(we);
  vscode.window.setStatusBarMessage(ok ? `Moved ${res.r.unused.length} images to ${folder}. Edit > Undo moves them back.` : 'The images could not be moved.', 8000);
}

async function findBroken(uri) {
  if (!(await pro.allowed('broken'))) return;
  const scope = await pickScope(uri);
  if (!scope) return;
  makeResolver();
  const res = await progress('Finding broken image references...', async (token) => {
    let files = await listFiles(scope.dir, scan.TEXT_GLOB_EXT, token);
    if (uri && uri.scheme === 'file' && !fs.statSync(uri.fsPath).isDirectory()) files = [uri.fsPath];
    const texts = await readTexts(files, token);
    if (token.isCancellationRequested) return null;
    return { list: scan.brokenRefs(texts, (raw, p) => resolver.resolve(raw, p)), texts };
  });
  if (!res) return;
  diags.clear();
  const byFile = new Map();
  for (const b of res.list) {
    const d = new vscode.Diagnostic(new vscode.Range(b.line, b.start, b.line, b.end), `Image not found: ${b.raw}`, vscode.DiagnosticSeverity.Warning);
    d.source = 'Image Preview';
    if (!byFile.has(b.path)) byFile.set(b.path, []);
    byFile.get(b.path).push(d);
  }
  for (const [f, ds] of byFile) diags.set(vscode.Uri.file(f), ds);
  await openReport(scan.brokenMarkdown(res.list, { rel: relPath, scope: relPath(scope.dir) === scope.dir ? path.basename(scope.dir) : relPath(scope.dir) || path.basename(scope.dir), textCount: res.texts.length }));
  await pro.produced('broken');
  refreshPro();
}

async function weightReport(uri) {
  if (!(await pro.allowed('weight'))) return;
  const scope = await pickScope(uri);
  if (!scope) return;
  const maxKB = setting('weightMaxKB', 200), maxSide = setting('weightMaxSide', 2560);
  const rep = await progress('Measuring images...', async (token) => {
    const images = await listFiles(scope.dir, scan.IMAGE_GLOB_EXT, token);
    const infos = [];
    for (const p of images) { if (token.isCancellationRequested) return null; const i = fileInfo(p); if (i) infos.push(i); }
    return scan.weightReport(infos, { maxKB, maxSide });
  });
  if (!rep) return;
  await openReport(scan.weightMarkdown(rep, { rel: relPath, scope: relPath(scope.dir) === scope.dir ? path.basename(scope.dir) : relPath(scope.dir) || path.basename(scope.dir), maxKB, maxSide }));
  await pro.produced('weight');
  refreshPro();
}

function refreshPro() { if (reach) reach.refresh(); }

// ---------------- activation ----------------
function activate(context) {
  ctxRef = context;
  cacheDir = context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'data-uri') : '';
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Image Preview' });
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  const sub = (d) => context.subscriptions.push(d);
  diags = vscode.languages.createDiagnosticCollection('imagePreview');
  sub(diags);
  sub({ dispose() { for (const t of gutterTypes.values()) t.dispose(); gutterTypes.clear(); for (const t of timers.values()) clearTimeout(t); } });
  makeResolver();

  sub(vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'untitled' }], { provideHover }));
  sub(vscode.window.onDidChangeVisibleTextEditors(() => refreshAll()));
  sub(vscode.workspace.onDidChangeTextDocument((e) => { if (e.contentChanges.length) schedule(e.document); }));
  sub(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(PREFIX)) { makeResolver(); refreshAll(); }
    if (e.affectsConfiguration(`${PREFIX}.showProTools`)) refreshPro();
  }));
  if (vscode.workspace.onDidChangeWorkspaceFolders) sub(vscode.workspace.onDidChangeWorkspaceFolders(() => { nameIndex = null; makeResolver(); refreshAll(); }));
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher(`**/*.${scan.IMAGE_GLOB_EXT}`);
    const changed = (u) => { infoCache.delete(u.fsPath); if (nameIndex && nameIndex.state === 'ready') nameIndex = null; clearTimeout(timers.get('fs')); timers.set('fs', setTimeout(() => { makeResolver(); refreshAll(); }, 500)); };
    sub(w.onDidCreate(changed)); sub(w.onDidDelete(changed)); sub(w.onDidChange(changed)); sub(w);
    const tw = vscode.workspace.createFileSystemWatcher('**/{tsconfig,jsconfig}*.json');
    const tc = () => { makeResolver(); refreshAll(); };
    sub(tw.onDidCreate(tc)); sub(tw.onDidDelete(tc)); sub(tw.onDidChange(tc)); sub(tw);
  }

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.toggleGutter`, async () => {
    const on = !setting('gutter', true);
    await vscode.workspace.getConfiguration(PREFIX).update('gutter', on, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(on ? 'Image thumbnails in the gutter are on.' : 'Image thumbnails in the gutter are off.', 4000);
  });
  reg(`${PREFIX}.openSample`, async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(context.extensionUri, 'samples', 'demo', 'src', 'App.tsx'));
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#imgPreview.start`, false));
  reg(`${PREFIX}.findUnused`, reach.wrap((uri) => findUnused(uri && uri.scheme ? uri : null)));
  reg(`${PREFIX}.findBroken`, reach.wrap((uri) => findBroken(uri && uri.scheme ? uri : null)));
  reg(`${PREFIX}.weightReport`, reach.wrap((uri) => weightReport(uri && uri.scheme ? uri : null)));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));

  refreshAll();
}

function deactivate() {}

module.exports = { activate, deactivate, _internal: { provideHover, fileInfo, updateEditor, byName, resolver: () => resolver } };
