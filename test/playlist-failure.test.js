const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const expired = Object.assign(new Error('Response code 410 (Gone)'), { response: { statusCode: 410 } });

test('single download reports an expired playlist without creating a task', async () => {
  const handlers = {};
  const replies = [];
  let requests = 0;
  const context = {
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    normalizeTaskUrl: value => value.trim(), inferTaskName: () => '',
    Parser: class { constructor() { this.manifest = { segments: [], playlists: [] }; } },
    got: async () => { requests++; throw expired; },
    logger: { info() {}, error() {} }, httpTimeout: {}, proxy_agent: {},
    playlistFailureMessage: error => error.response.statusCode === 410 ? '视频源已失效（HTTP 410）' : '',
    startDownload: () => assert.fail('download must not start'),
    startDownloadLive: () => assert.fail('live download must not start')
  };
  vm.createContext(context);
  const start = source.indexOf("ipcMain.on('task-add',");
  const end = source.indexOf("\nipcMain.on('task-add-muti'", start);
  vm.runInContext(source.slice(start, end), context);
  await handlers['task-add']({ sender: { send: (name, reply) => replies.push(reply) } }, {
    url: 'https://example.test/expired.m3u8', headers: '', taskName: ''
  });
  assert.equal(requests, 1);
  assert.equal(replies[0].code, -1);
  assert.match(replies[0].message, /HTTP 410/);
});

test('batch download marks a zero-segment task as failed before queuing or merging', async () => {
  const videos = [];
  const notices = [];
  let queued = false;
  const context = {
    app: { getAppPath: () => 'C:/app' }, path, fs: { writeFileSync() {} },
    globalCond: {}, activeRuns: new Map(), activeQueues: new Map(),
    globalConfigSaveVideoDir: 'C:/downloads', globalConfigVideoPath: 'unused', configVideos: videos,
    normalizeTaskUrl: value => value.trim(), inferTaskName: () => 'example',
    Parser: class { constructor() { this.manifest = { segments: [] }; } },
    got: async () => { throw expired; }, trackTaskRequest: (id, request) => request,
    logger: { info() {}, error() {} }, httpTimeout: {}, proxy_agent: {},
    playlistFailureMessage: () => '视频源已失效（HTTP 410）',
    dateFormat: () => 'now',
    mainWindow: { webContents: { send: (...args) => notices.push(args) } },
    async: { queue: () => { queued = true; } }
  };
  vm.createContext(context);
  const start = source.indexOf('async function startDownload(');
  const end = source.indexOf('\nfunction sleep(', start);
  vm.runInContext(`${source.slice(start, end)}\nthis.startDownload = startDownload;`, context);
  await context.startDownload({ url: 'https://example.test/expired.m3u8', headers: {} });
  assert.equal(queued, false);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].success, false);
  assert.equal(videos[0].paused, true);
  assert.match(videos[0].status, /HTTP 410/);
  assert.equal(notices[0][0], 'task-notify-create');
});
