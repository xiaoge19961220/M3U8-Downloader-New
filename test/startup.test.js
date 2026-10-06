const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('first launch accepts a missing download history file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-startup-test-'));
  const errors = [];
  const context = {
    fs,
    globalConfigVideoPath: path.join(directory, 'config_videos.json'),
    logger: { error: error => errors.push(error) }
  };
  try {
    vm.createContext(context);
    const start = source.indexOf('function loadConfigVideos()');
    const end = source.indexOf("\napp.on('ready'", start);
    vm.runInContext(`${source.slice(start, end)}\nthis.loadConfigVideos = loadConfigVideos;`, context);
    assert.deepEqual(Array.from(context.loadConfigVideos()), []);
    assert.deepEqual(errors, []);

    fs.writeFileSync(context.globalConfigVideoPath, 'invalid json');
    assert.deepEqual(Array.from(context.loadConfigVideos()), []);
    assert.equal(errors.length, 1);

    fs.writeFileSync(context.globalConfigVideoPath, '[{"id":1}]');
    assert.equal(context.loadConfigVideos()[0].id, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
