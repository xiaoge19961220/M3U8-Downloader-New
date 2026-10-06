const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const test = require('node:test');

test('live segments download concurrently and enter the merge stream in order', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('async function startDownloadLive(object)');
  const end = source.indexOf('\nfunction formatTime(', start);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-live-test-'));
  const ffmpegPath = path.join(directory, 'ffmpeg.exe');
  fs.writeFileSync(ffmpegPath, 'mock');
  const pushed = [];
  const attempts = new Map();
  let active = 0;
  let peak = 0;
  let requests = 0;

  const context = {
    URL, fs, path, console,
    app: { getAppPath: () => directory },
    globalConfigSaveVideoDir: directory,
    globalConfigVideoPath: path.join(directory, 'videos.json'),
    configVideos: [],
    mainWindow: { webContents: { send() {} } },
    globalCond: {},
    activeMerges: new Map(),
    logger: { info() {}, error() {} },
    dateFormat: () => 'test',
    httpTimeout: {},
    proxy_agent: null,
    ffmpegPath,
    FFmpegStreamReadable: class { push(value) { if (value) pushed.push(value.toString()); } },
    ffmpeg: function () {
      return {
        setFfmpegPath() { return this; }, videoCodec() { return this; },
        audioCodec() { return this; }, save() { return this; }, on() { return this; }
      };
    },
    Parser: class {
      push() {}
      end() {
        this.manifest = { segments: Array.from({ length: 5 }, (_, index) => ({
          uri: `segment-${index + 1}.ts`, duration: 0
        })) };
      }
    },
    got: async () => ++requests === 1 ? { body: '#EXTM3U' } : null,
    trackTaskRequest: (id, request) => request,
    downloadTaskFile: (...args) => context.download(...args.slice(1)),
    download: async (uri, targetDirectory, options) => {
      const name = path.basename(uri);
      attempts.set(name, (attempts.get(name) || 0) + 1);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, (6 - Number(name.match(/\d+/)[0])) * 10));
      active -= 1;
      if (name === 'segment-3.ts' && attempts.get(name) === 1) throw new Error('temporary failure');
      fs.writeFileSync(path.join(targetDirectory, options.filename), name);
    },
    sleep: async () => {}
  };

  try {
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\nthis.startDownloadLive = startDownloadLive;`, context);
    await context.startDownloadLive({ id: 1, url: 'https://example.test/live/index.m3u8', taskName: 'live' });
    assert.ok(peak > 1 && peak <= 4, `unexpected concurrent downloads: ${peak}`);
    assert.equal(attempts.get('segment-3.ts'), 2);
    assert.deepEqual(pushed, Array.from({ length: 5 }, (_, index) => `segment-${index + 1}.ts`));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('segment merge stream preserves file order and reports progress', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf('function createSegmentStream(');
  const end = source.indexOf('\nasync function startDownloadLive(', start);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-merge-test-'));
  const files = ['one.ts', 'two.ts', 'three.ts'].map(name => path.join(directory, name));
  const progress = [];
  try {
    ['abc', 'def', 'ghi'].forEach((value, index) => fs.writeFileSync(files[index], value));
    const context = { Readable, fs };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\nthis.createSegmentStream = createSegmentStream;`, context);
    const chunks = [];
    for await (const chunk of context.createSegmentStream(files, (done, total) => progress.push([done, total]))) {
      chunks.push(chunk);
    }
    assert.equal(Buffer.concat(chunks).toString(), 'abcdefghi');
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
