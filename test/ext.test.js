'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadExtension } = require('./support/vscode-stub');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(ROOT, 'samples', 'demo');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.ext.activate(s.context);
  return s;
}
async function withWorkspace(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprev-ws-'));
  try {
    for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), t); }
    await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const PNG = fs.readFileSync(path.join(DEMO, 'src/assets/pattern.png'));

test('listing rules: name, description, 5 tags, engine, no dependencies, Pro titles, Explorer wrappers', () => {
  assert.equal(pkg.displayName, 'Image Preview & Image Hover');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('Image preview'));
  assert.deepEqual(pkg.keywords, ['image preview', 'image hover', 'gutter preview', 'svg', 'assets']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.ok(!pkg.dependencies);
  assert.ok(!pkg.activationEvents.includes('*'));
  for (const id of ['findUnused', 'findBroken', 'weightReport']) assert.match(pkg.contributes.commands.find((c) => c.command === `imgPreview.${id}`).title, /\(Pro\)$/);
  const ctx = pkg.contributes.menus['explorer/context'].filter((m) => /zovoPro/.test(m.command));
  assert.equal(ctx.length, 3);
  for (const m of ctx) {
    assert.ok(!('title' in m), 'VS Code ignores a title on a menu item');
    assert.match(pkg.contributes.commands.find((c) => c.command === m.command).title, /^Zovo Pro: /);
    assert.match(m.when, /config\.imgPreview\.showProTools/);
    assert.ok(pkg.contributes.menus.commandPalette.some((p) => p.command === m.command && p.when === 'false'));
  }
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(k.startsWith('imgPreview.'), k);
});

test('every command is registered; walkthrough files exist; nothing shows or opens on activation', () => {
  const s = activate(DEMO);
  for (const c of pkg.contributes.commands) assert.ok(s.commands.has(c.command), c.command);
  for (const step of pkg.contributes.walkthroughs[0].steps) for (const f of [step.media && step.media.image, step.media && step.media.markdown].filter(Boolean)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length + s.log.external.length + s.log.opened.length, 0);
  s.restore();
});

test('no network module in the extension code (local files only)', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(ROOT, 'src'));
  for (const f of files) {
    if (/[\\/]license[\\/]/.test(f)) continue; // the shared license module: one GitHub call only after an Unlock click
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /require\(['"](https?|net|tls|http2|dgram)['"]\)|\bfetch\(|XMLHttpRequest/, f);
  }
});

test('gutter: one thumbnail per line for files, data URIs and aliases; none for remote or missing', () => {
  const s = activate(DEMO);
  const file = path.join(DEMO, 'src/App.tsx');
  const ed = s.show(fs.readFileSync(file, 'utf8'), 'typescriptreact', file);
  const lines = new Map();
  for (const [t, ranges] of ed.decorations) for (const r of ranges) lines.set(r.start.line + 1, path.basename(t.o.gutterIconPath.fsPath));
  assert.equal(lines.get(3), 'logo.svg');
  assert.equal(lines.get(4), 'photo.jpg');
  assert.equal(lines.get(5), 'avatar.gif');
  assert.equal(lines.get(7), 'hero image.png');
  assert.equal(lines.get(8), 'banner.png');
  assert.equal(lines.get(9), 'icon.webp');
  assert.equal(lines.get(10), 'photo.avif');
  assert.match(lines.get(11), /^[0-9a-f]{20}\.png$/, 'data URI written to the cache folder');
  assert.ok(!lines.has(12) && !lines.has(13), 'remote and missing: no icon');
  for (const t of s.log.types) assert.equal(t.o.gutterIconSize, 'contain');
  s.config.gutter = false;
  s.listeners.config.forEach((f) => f({ affectsConfiguration: () => true }));
  let n = 0; for (const [, ranges] of ed.decorations) n += ranges.length;
  assert.equal(n, 0, 'gutter off clears the icons');
  s.restore();
});

test('hover: image with pixel and file size; data URI; remote link never fetched; missing lists tried paths', () => {
  const s = activate(DEMO);
  const file = path.join(DEMO, 'src/App.tsx');
  const text = fs.readFileSync(file, 'utf8');
  const doc = s.makeDoc(s.vscode.Uri.file(file), text, 'typescriptreact');
  const at = (line, needle) => new s.vscode.Position(line - 1, text.split('\n')[line - 1].indexOf(needle) + 2);
  const hv = s.ext._internal.provideHover;
  let h = hv(doc, at(4, './assets/photo.jpg'));
  assert.match(h.contents.value, /!\[image\]\(file:\/\/.*photo\.jpg\|width=220,height=124\)/);
  assert.match(h.contents.value, /\*\*JPEG\*\* · 960 × 540 px · 41 KB/);
  assert.match(h.contents.value, /command:vscode\.open/);
  assert.match(h.contents.value, /\[Rate\]\(.*\) · \[More free viewers\]/);
  assert.match(h.contents.value, /command:imgPreview\.getPro\?%5B%22footer%22%5D/);
  h = hv(doc, at(5, '@assets'));
  assert.match(h.contents.value, /width=128,height=128/, 'small images are not scaled up');
  h = hv(doc, at(11, 'data:'));
  assert.match(h.contents.value, /\*\*PNG\*\* · 64 × 64 px · 186 B · transparent · data URI, base64/);
  h = hv(doc, at(12, 'https'));
  assert.match(h.contents.value, /Remote image, not loaded/);
  assert.doesNotMatch(h.contents.value, /!\[/);
  h = hv(doc, at(13, './assets/old'));
  assert.match(h.contents.value, /Image not found:\*\* `\.\/assets\/old-logo\.png`/);
  assert.match(h.contents.value, /Looked for `src\/assets\/old-logo\.png`/);
  assert.equal(hv(doc, new s.vscode.Position(0, 3)), undefined);
  s.config.hover = false;
  assert.equal(hv(doc, at(4, './assets/photo.jpg')), undefined);
  assert.equal(s.log.external.length, 0);
  s.restore();
});

test('Pro: 3 tries each counted after the report; then the Zovo Pro panel; unused images move after a confirm', async () => {
  await withWorkspace({ 'img/used.png': PNG, 'img/orphan.png': PNG, 'img/old/also-orphan.png': PNG, 'src/a.ts': "import u from '../img/used.png';\nconst x = '../img/gone.png';\n" }, async (dir) => {
    const s = activate(dir);
    // 1st run: report, then "Keep" at the confirm
    s.ui.warn.push(undefined);
    await s.commands.get('imgPreview.findUnused')();
    let rep = s.log.opened.at(-1).document || s.log.opened.at(-1);
    assert.match(rep.getText(), /2 of 3 images are not named/);
    assert.match(rep.getText(), /orphan\.png/);
    assert.equal(s.state.get('imgPreview.proTrial').unused, 1);
    assert.ok(fs.existsSync(path.join(dir, 'img/orphan.png')));
    // 2nd run: confirm the move
    s.ui.warn.push('Move 2 to _unused-images');
    await s.commands.get('imgPreview.findUnused')();
    assert.ok(fs.existsSync(path.join(dir, '_unused-images/img/orphan.png')));
    assert.ok(fs.existsSync(path.join(dir, '_unused-images/img/old/also-orphan.png')));
    assert.ok(fs.existsSync(path.join(dir, 'img/used.png')));
    assert.equal(s.state.get('imgPreview.proTrial').unused, 2);
    // 3rd run: the archive folder is skipped, so nothing is unused
    await s.commands.get('imgPreview.findUnused')();
    rep = s.log.opened.at(-1);
    assert.match(rep.getText(), /0 of 1 images/);
    assert.equal(s.state.get('imgPreview.proTrial').unused, 3);
    // 4th: no report, the Zovo Pro panel instead
    const before = s.log.opened.length;
    await s.commands.get('imgPreview.findUnused')();
    assert.equal(s.log.opened.length, before);
    assert.ok([...s.log.info, ...s.log.warn].some((m) => /Find unused images is part of Zovo Pro/.test(m.text)));
    // broken: report + Problems panel
    await s.commands.get('imgPreview.findBroken')();
    assert.match(s.log.opened.at(-1).getText(), /1 reference in 1 file/);
    const d = [...s.diags.values()][0];
    assert.equal(d[0].message, 'Image not found: ../img/gone.png');
    assert.equal(d[0].source, 'Image Preview');
    assert.equal(s.state.get('imgPreview.proTrial').broken, 1);
    // weight report
    await s.commands.get('imgPreview.weightReport')();
    assert.match(s.log.opened.at(-1).getText(), /# Image weight report/);
    assert.match(s.log.opened.at(-1).getText(), /64 × 64/);
    assert.equal(s.state.get('imgPreview.proTrial').weight, 1);
    // the Explorer wrapper runs the tool on the clicked folder, tagged ctx
    await s.commands.get('imgPreview.zovoPro.weight')(s.vscode.Uri.file(path.join(dir, 'img')));
    assert.equal(s.state.get('imgPreview.proTrial').weight, 2);
    assert.match(s.log.opened.at(-1).getText(), /Image weight report for img/);
    s.restore();
  });
});

test('Escape at the folder pick uses no try; no folder open gives a plain message and uses no try', async () => {
  const s = activate();
  await s.commands.get('imgPreview.weightReport')();
  assert.match(s.log.info.at(-1).text, /Open a folder first/);
  assert.equal((s.state.get('imgPreview.proTrial') || {}).weight, undefined);
  s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(DEMO), name: 'a' }, { uri: s.vscode.Uri.file(ROOT), name: 'b' }];
  s.ui.quick.push(undefined);
  await s.commands.get('imgPreview.weightReport')();
  assert.equal((s.state.get('imgPreview.proTrial') || {}).weight, undefined);
  s.restore();
});
