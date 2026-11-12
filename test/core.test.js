'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const dims = require('../src/core/dims');
const refs = require('../src/core/refs');
const { createResolver, parseJsonc, applyPaths, decodeData, looksLikePath } = require('../src/core/resolve');
const scan = require('../src/core/scan');

const DEMO = path.join(__dirname, '..', 'samples', 'demo');
const A = (f) => path.join(DEMO, f);

test('header sizes of the sample images (PNG, JPEG, GIF, WebP, AVIF, SVG)', () => {
  const want = { 'src/assets/photo.jpg': ['jpeg', 960, 540], 'public/banner.png': ['png', 1200, 400], 'src/assets/pattern.png': ['png', 64, 64], 'src/assets/hero image.png': ['png', 800, 450],
    'src/assets/avatar.gif': ['gif', 128, 128], 'src/assets/icon.webp': ['webp', 128, 128], 'src/assets/photo.avif': ['avif', 960, 540], 'src/assets/logo.svg': ['svg', 120, 120] };
  for (const [f, [type, w, h]] of Object.entries(want)) {
    const r = dims.probe(fs.readFileSync(A(f)));
    assert.deepEqual([r.type, r.width, r.height], [type, w, h], f);
  }
  assert.equal(dims.probe(fs.readFileSync(A('src/assets/pattern.png'))).alpha, true);
  assert.equal(dims.probe(fs.readFileSync(A('public/banner.png'))).alpha, false);
});

test('BMP, ICO, TIFF, BigTIFF and APNG headers built by hand', () => {
  const bmp = Buffer.alloc(54); bmp.write('BM', 0); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(31, 18); bmp.writeInt32LE(-17, 22);
  assert.deepEqual([dims.probe(bmp).type, dims.probe(bmp).width, dims.probe(bmp).height], ['bmp', 31, 17]);
  const ico = Buffer.alloc(6 + 32); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(2, 4); ico[6] = 16; ico[7] = 16; ico[22] = 0; ico[23] = 0;
  assert.deepEqual([dims.probe(ico).type, dims.probe(ico).width, dims.probe(ico).height], ['ico', 256, 256]);
  const tif = Buffer.alloc(64); tif.write('II*\0', 0); tif.writeUInt32LE(8, 4); tif.writeUInt16LE(2, 8);
  tif.writeUInt16LE(256, 10); tif.writeUInt16LE(3, 12); tif.writeUInt32LE(1, 14); tif.writeUInt16LE(640, 18);
  tif.writeUInt16LE(257, 22); tif.writeUInt16LE(4, 24); tif.writeUInt32LE(1, 26); tif.writeUInt32LE(480, 30);
  assert.deepEqual([dims.probe(tif).width, dims.probe(tif).height], [640, 480]);
  const big = Buffer.alloc(80); big.write('II+\0', 0); big.writeUInt16LE(8, 4); big.writeUInt32LE(16, 8); big.writeUInt32LE(2, 16);
  big.writeUInt16LE(256, 24); big.writeUInt16LE(3, 26); big.writeUInt32LE(1, 28); big.writeUInt16LE(300, 36);
  big.writeUInt16LE(257, 44); big.writeUInt16LE(16, 46); big.writeUInt32LE(1, 48); big.writeUInt32LE(200, 56);
  assert.deepEqual([dims.probe(big).width, dims.probe(big).height], [300, 200]);
  const png = fs.readFileSync(A('src/assets/pattern.png'));
  const actl = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12)]);
  const apng = Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)]);
  assert.equal(dims.probe(apng).type, 'apng');
});

test('hostile and cut files give null or zero sizes, never a throw', () => {
  for (const b of [Buffer.alloc(0), Buffer.from('hello'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from('RIFF0000WEBPVP8X'), Buffer.from('<svg'), Buffer.alloc(30).fill(0xff)]) {
    const r = dims.probe(b);
    assert.ok(r === null || (r.width >= 0 && r.height >= 0));
  }
  const jpg = fs.readFileSync(A('src/assets/photo.jpg'));
  const r = dims.probe(jpg.subarray(0, 40));
  assert.equal(r.type, 'jpeg');
  assert.equal(r.width, 0);
});

test('SVG sizes: width/height with units, viewBox only, one side from the viewBox', () => {
  assert.deepEqual(dims.svg('<svg width="2in" height="96pt"/>').width, 192);
  assert.deepEqual(dims.svg('<svg width="2in" height="96pt"/>').height, 128);
  assert.deepEqual([dims.svg('<svg viewBox="0 0 24 12">').width, dims.svg('<svg viewBox="0 0 24 12">').height], [24, 12]);
  assert.deepEqual([dims.svg('<svg width="48" viewBox="0 0 24 12">').width, dims.svg('<svg width="48" viewBox="0 0 24 12">').height], [48, 24]);
  assert.equal(dims.svg('<svg width="100%" height="100%">').width, 0);
  assert.equal(dims.probe(Buffer.from('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="x" width="10" height="20"></svg>')).height, 20);
});

test('humanSize', () => {
  assert.equal(dims.humanSize(512), '512 B');
  assert.equal(dims.humanSize(1536), '1.5 KB');
  assert.equal(dims.humanSize(150 * 1024), '150 KB');
  assert.equal(dims.humanSize(3.5 * 1024 * 1024), '3.50 MB');
});

test('finds references in JS, CSS, Markdown, HTML, YAML and data URIs', () => {
  const f = (l) => refs.findInLine(l).map((r) => [r.raw, r.kind]);
  assert.deepEqual(f("import logo from './assets/logo.svg';"), [['./assets/logo.svg', 'string']]);
  assert.deepEqual(f('.a { background: url("../img/hero bg.jpg"), url(img/b.png); }'), [['../img/hero bg.jpg', 'url'], ['img/b.png', 'url']]);
  assert.deepEqual(f('![x](docs/shot%201.png "t") ![y](<my pic.png>)'), [['docs/shot%201.png', 'url'], ['my pic.png', 'url']]);
  assert.deepEqual(f('<img src="/a.webp" srcset="a-400.jpg 400w, a-800.jpg 800w">'), [['/a.webp', 'url'], ['a-400.jpg', 'url'], ['a-800.jpg', 'url']]);
  assert.deepEqual(f('icon: images/icon.png'), [['images/icon.png', 'bare']]);
  assert.deepEqual(f('<img src=foo/bar.gif alt=x>'), [['foo/bar.gif', 'bare']]);
  assert.deepEqual(f("mime = 'image/png'; glob = '**/*.png'; name = 'readme.md'"), []);
  const d = refs.findInLine(`url("data:image/svg+xml;utf8,<svg xmlns='x' width='4' height='4'/>")`);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'data');
  assert.ok(d[0].raw.endsWith("/>"));
  const line = 'const s = "x.png"; const t = "y.jpg";';
  const r = refs.findInLine(line);
  assert.equal(line.slice(r[1].start, r[1].end), 'y.jpg');
  assert.equal(refs.findInText('a.png\nb.png\nc.png', 2).length, 2);
});

test('resolves the demo project: relative, @/, tsconfig paths, public /, spaces and %20, data, remote, missing', () => {
  const r = createResolver({ roots: [DEMO] });
  const app = A('src/App.tsx');
  const rel = (x) => (x.path ? path.relative(DEMO, x.path) : x.kind);
  assert.equal(rel(r.resolve('@/assets/logo.svg', app)), 'src/assets/logo.svg');
  assert.equal(rel(r.resolve('@assets/avatar.gif', app)), 'src/assets/avatar.gif');
  assert.equal(rel(r.resolve('./assets/photo.jpg', app)), 'src/assets/photo.jpg');
  assert.equal(rel(r.resolve('/banner.png', app)), 'public/banner.png');
  assert.equal(rel(r.resolve('./assets/hero%20image.png', app)), 'src/assets/hero image.png');
  assert.equal(rel(r.resolve('assets/hero image.png?v=3#top', app)), 'src/assets/hero image.png');
  assert.equal(rel(r.resolve('src/assets/logo.svg', A('README.md'))), 'src/assets/logo.svg');
  assert.equal(r.resolve('https://example.com/a.png', app).kind, 'remote');
  assert.equal(r.resolve('//cdn.example.com/a.png', app).url, 'https://cdn.example.com/a.png');
  assert.equal(r.resolve('${base}/a.png', app).kind, 'dynamic');
  const miss = r.resolve('./assets/old-logo.png', app);
  assert.equal(miss.kind, 'missing');
  assert.ok(miss.tried.length >= 1);
  assert.equal(r.resolve('data:image/png;base64,AAAA', app).kind, 'data');
  assert.equal(rel(r.resolve('file://' + A('src/assets/logo.svg'), app)), 'src/assets/logo.svg');
});

test('aliases setting, ~ for node_modules and home, monorepo public folders, by-name lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprev-'));
  try {
    const mk = (f) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'); };
    ['web/images/a.png', 'node_modules/pkg/icon.svg', 'apps/site/public/og.png', 'apps/site/src/page.tsx', 'home/me/pic.jpg', 'data/x.json', 'data/images/beans.jpg'].forEach(mk);
    const r = createResolver({ roots: [dir], aliases: { '#img': 'web/images' }, home: path.join(dir, 'home/me'), byName: (n) => (n === 'beans.jpg' ? path.join(dir, 'data/images/beans.jpg') : null) });
    const page = path.join(dir, 'apps/site/src/page.tsx');
    assert.equal(r.resolve('#img/a.png', page).path, path.join(dir, 'web/images/a.png'));
    assert.equal(r.resolve('~pkg/icon.svg', page).path, path.join(dir, 'node_modules/pkg/icon.svg'));
    assert.equal(r.resolve('~/pic.jpg', page).path, path.join(dir, 'home/me/pic.jpg'));
    assert.equal(r.resolve('/og.png', page).path, path.join(dir, 'apps/site/public/og.png'));
    const b = r.resolve('beans.jpg', path.join(dir, 'data/x.json'));
    assert.equal(b.path, path.join(dir, 'data/images/beans.jpg'));
    assert.equal(b.byName, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tsconfig: comments, trailing commas, extends, paths without baseUrl', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "//not a comment", /* b */ "b": [1,2,], }'), { a: '//not a comment', b: [1, 2] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprev-ts-'));
  try {
    fs.mkdirSync(path.join(dir, 'pkg/src/img'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tsconfig.base.json'), '{ "compilerOptions": { "paths": { "~img/*": ["./pkg/src/img/*"] } } }');
    fs.writeFileSync(path.join(dir, 'pkg/tsconfig.json'), '{ "extends": "../tsconfig.base.json" }');
    fs.writeFileSync(path.join(dir, 'pkg/src/img/k.png'), 'x');
    fs.writeFileSync(path.join(dir, 'pkg/src/a.ts'), '');
    const r = createResolver({ roots: [dir] });
    assert.equal(r.resolve('~img/k.png', path.join(dir, 'pkg/src/a.ts')).path, path.join(dir, 'pkg/src/img/k.png'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(applyPaths('@/a/b.png', [{ pattern: '@/*', targets: ['/x/src/*', '/y/*'] }]), ['/x/src/a/b.png', '/y/a/b.png']);
  assert.deepEqual(applyPaths('logo', [{ pattern: 'logo', targets: ['/x/logo.svg'] }]), ['/x/logo.svg']);
});

test('data URIs decode with a size cap; paths that look like paths', () => {
  const r = createResolver({}).resolve('data:image/svg+xml;utf8,%3Csvg width=%222%22 height=%223%22/%3E', '');
  assert.equal(dims.probe(decodeData(r)).height, 3);
  const big = createResolver({}).resolve('data:image/png;base64,' + 'A'.repeat(2000), '');
  assert.equal(decodeData(big, 100), null);
  assert.ok(looksLikePath('./a.png', 'string'));
  assert.ok(looksLikePath('img/a.png', 'string'));
  assert.ok(!looksLikePath('beans.jpg', 'string'));
  assert.ok(looksLikePath('beans.jpg', 'url'));
  assert.ok(!looksLikePath('images/a.png', 'bare'));
});

test('Pro reports: unused, broken and weight on a small workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprev-scan-'));
  try {
    const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
    put('img/used.png', 'x'); put('img/by-name.png', 'x'); put('img/arrow.svg', '<svg/>'); put('img/orphan.png', 'x'); put('img/My Pic.png', 'x');
    put('src/a.ts', "import u from '../img/used.png';\nconst n = 'arrow';\nconst gone = '../img/gone.png';\nconst p = 'My%20Pic.png';");
    put('docs/x.md', 'see by-name.png and ![](missing.jpg)');
    const r = createResolver({ roots: [dir] });
    const texts = ['src/a.ts', 'docs/x.md'].map((f) => ({ path: path.join(dir, f), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
    const images = ['used.png', 'by-name.png', 'arrow.svg', 'orphan.png', 'My Pic.png'].map((f) => path.join(dir, 'img', f));
    const u = scan.unusedImages(images, texts, r.resolve);
    assert.deepEqual(u.unused.map((p) => path.basename(p)), ['orphan.png']);
    const b = scan.brokenRefs(texts, r.resolve);
    assert.deepEqual(b.map((x) => `${path.basename(x.path)}:${x.line + 1}:${x.raw}`), ['a.ts:3:../img/gone.png', 'x.md:1:missing.jpg']);
    const md = scan.brokenMarkdown(b, { rel: (p) => path.relative(dir, p), scope: 'ws', textCount: 2 });
    assert.match(md, /2 references in 2 files/);
    assert.match(md, /\(file:\/\/.*a\.ts#L3\)/);
    const w = scan.weightReport([{ path: '/a.png', size: 900 * 1024, width: 3000, height: 2000, type: 'png', alpha: false }, { path: '/b.jpg', size: 10 * 1024, width: 100, height: 100, type: 'jpeg' }, { path: '/c.svg', size: 150 * 1024, type: 'svg' }], { maxKB: 200, maxSide: 2560 });
    assert.deepEqual(w.rows.map((x) => x.path), ['/a.png', '/c.svg', '/b.jpg']);
    assert.equal(w.flagged, 2);
    assert.ok(w.rows[0].flags.some((f) => /JPEG or WebP/.test(f)));
    assert.match(scan.weightMarkdown(w, { rel: (p) => p, scope: 'ws' }), /3 images, 1\.04 MB in all\. 2 flagged/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
