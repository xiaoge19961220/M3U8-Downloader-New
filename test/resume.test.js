const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('resume reuses completed segments and retries missing or empty segments', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function scanDownloadedSegments(');
  const end = source.indexOf('\nasync function startDownload(', start);
  assert.ok(start >= 0 && end > start);
  const scan = vm.runInNewContext(`${source.slice(start, end)}; scanDownloadedSegments`, { fs, path });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-resume-'));
  try {
    fs.writeFileSync(path.join(dir, '000001.ts'), 'complete');
    fs.writeFileSync(path.join(dir, '000002.ts'), '');
    fs.writeFileSync(path.join(dir, '000003.ts.dl'), 'partial');
    const result = scan(dir, 3);
    assert.equal(result.downloaded, 1);
    assert.deepEqual(Array.from(result.missing), [1, 2]);
    assert.equal(fs.readFileSync(path.join(dir, '000001.ts'), 'utf8'), 'complete');
    assert.equal(fs.existsSync(path.join(dir, '000002.ts')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
