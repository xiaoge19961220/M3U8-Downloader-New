const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const helperStart = source.indexOf('const DEFAULT_SEGMENT_RETRIES');
const helperEnd = source.indexOf('\nfunction transformConfig(', helperStart);

test('retry setting accepts 0 through 30 and defaults invalid values', () => {
  const context = { URL, nconf: { get: () => undefined } };
  vm.createContext(context);
  vm.runInContext(`${source.slice(helperStart, helperEnd)}\nthis.normalize = normalizeSegmentRetryCount;`, context);
  assert.equal(context.normalize(undefined), 9);
  assert.equal(context.normalize('0'), 0);
  assert.equal(context.normalize(30), 30);
  assert.equal(context.normalize(-1), 9);
  assert.equal(context.normalize(31), 9);
  assert.equal(context.normalize(1.5), 9);
});

test('one failed segment request uses one retry attempt', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-retry-test-'));
  let requests = 0;
  const context = {
    URL, fs, path,
    nconf: { get: () => 2 },
    globalCond: { 42: true },
    httpTimeout: {},
    proxy_agent: null,
    logger: { debug() {}, error() {} },
    downloadTaskFile: async () => { requests += 1; throw new Error('temporary failure'); }
  };
  try {
    vm.createContext(context);
    const queueStart = source.indexOf('class QueueObject {');
    const queueEnd = source.indexOf('\nfunction queue_callback(', queueStart);
    vm.runInContext(`${source.slice(helperStart, helperEnd)}\n${source.slice(queueStart, queueEnd)}\nthis.QueueObject = QueueObject;`, context);
    const item = new context.QueueObject();
    item.id = 42;
    item.idx = 0;
    item.dir = directory;
    item.url = 'https://example.com/hls/index.m3u8';
    item.segment = { uri: '000001.ts' };
    item.maxRetries = 2;
    let failures = 0;
    item.catch = () => { failures += 1; };

    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => item.callback(resolve));
      assert.equal(requests, attempt + 1);
    }
    assert.equal(item.retry, 3);
    assert.equal(failures, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
