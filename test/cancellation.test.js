const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('deleting a task cancels requests, queued work, and merging', async () => {
  const start = source.indexOf('const activeRequests = new Map()');
  const end = source.indexOf('\nconst globalConfigDir', start);
  const context = { globalCond: { 42: true }, download() {} };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.state = { trackTaskRequest, cancelTask, activeQueues, activeMerges };`, context);

  let rejectRequest;
  let requestCancelled = false;
  const request = new Promise((resolve, reject) => { rejectRequest = reject; });
  request.cancel = () => {
    requestCancelled = true;
    rejectRequest(new Error('cancelled'));
  };
  context.state.trackTaskRequest(42, request);
  let queueKilled = false;
  let mergeKilled = false;
  let inputDestroyed = false;
  context.state.activeQueues.set(42, { kill: () => { queueKilled = true; } });
  context.state.activeMerges.set(42, {
    input: { destroy: () => { inputDestroyed = true; } },
    command: { kill: () => { mergeKilled = true; } }
  });

  context.state.cancelTask(42);
  await Promise.resolve();
  assert.equal(context.globalCond[42], false);
  assert.equal(requestCancelled, true);
  assert.equal(queueKilled, true);
  assert.equal(inputDestroyed, true);
  assert.equal(mergeKilled, true);
});

test('delete action cancels the selected task before removing its record', () => {
  const start = source.indexOf('function removeTaskDownloads(');
  const end = source.indexOf('\nfunction showDirInExploer(', start);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-delete-test-'));
  const dir = path.join(root, 'download-42');
  const output = path.join(root, 'download-42.mp4');
  const unrelated = path.join(root, 'keep.txt');
  const history = path.join(root, 'videos.json');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '000001.ts'), 'segment');
  fs.writeFileSync(output, 'video');
  fs.writeFileSync(unrelated, 'keep');
  const calls = [];
  const handlers = {};
  const context = {
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    configVideos: [{ id: 42, dir, taskName: 'download-42' }],
    cancelTask: id => calls.push(`cancel ${id}`),
    fs, path,
    globalConfigVideoPath: history,
    logger: {
      info: message => calls.push(message),
      error: error => { throw error; }
    }
  };
  try {
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    handlers.delvideo({ sender: { send: () => calls.push('reply') } }, 42);
    assert.deepEqual(calls, ['cancel 42', 'event=task_delete task_id=42 files=deleted', 'reply']);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.equal(fs.readFileSync(history, 'utf8'), '[]');
    assert.equal(context.configVideos.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clearing tasks removes every task directory and completed video', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-clear-test-'));
  const videos = [1, 2].map(id => ({ id, taskName: `task-${id}`, dir: path.join(root, `task-${id}`) }));
  for (const video of videos) {
    fs.mkdirSync(video.dir);
    fs.writeFileSync(path.join(video.dir, '000001.ts'), 'segment');
    fs.writeFileSync(path.join(root, `${video.taskName}.mp4`), 'video');
  }
  const handlers = {};
  const replies = [];
  const context = {
    fs, path,
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    configVideos: videos,
    cancelTask() {},
    globalConfigVideoPath: path.join(root, 'videos.json'),
    logger: { info() {}, error: error => { throw error; } }
  };
  try {
    vm.createContext(context);
    const helperStart = source.indexOf('function removeTaskDownloads(');
    const helperEnd = source.indexOf("\nipcMain.on('delvideo'", helperStart);
    const clearStart = source.indexOf("ipcMain.on('task-clear'");
    const clearEnd = source.indexOf("\nipcMain.on('task-add'", clearStart);
    vm.runInContext(`${source.slice(helperStart, helperEnd)}\n${source.slice(clearStart, clearEnd)}`, context);
    handlers['task-clear']({ sender: { send: (_, remaining) => replies.push(Array.from(remaining)) } });

    assert.deepEqual(replies, [[]]);
    assert.equal(fs.readFileSync(context.globalConfigVideoPath, 'utf8'), '[]');
    for (const video of videos) {
      assert.equal(fs.existsSync(video.dir), false);
      assert.equal(fs.existsSync(path.join(root, `${video.taskName}.mp4`)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleting one of two tasks with a shared directory keeps files until the last task is deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-shared-test-'));
  const dir = path.join(root, 'shared');
  const output = path.join(root, 'shared.mp4');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '000001.ts'), 'segment');
  fs.writeFileSync(output, 'video');
  try {
    const handlers = {};
    const context = {
      fs, path,
      ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
      configVideos: [{ id: 1, taskName: 'shared', dir }, { id: 2, taskName: 'shared', dir }],
      cancelTask() {}, logger: { info() {}, error: error => { throw error; } },
      globalConfigVideoPath: path.join(root, 'videos.json')
    };
    vm.createContext(context);
    const start = source.indexOf('function removeTaskDownloads(');
    const end = source.indexOf('\nfunction showDirInExploer(', start);
    vm.runInContext(source.slice(start, end), context);
    handlers.delvideo({ sender: { send() {} } }, 1);
    assert.equal(context.configVideos.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, '000001.ts'), 'utf8'), 'segment');
    assert.equal(fs.readFileSync(output, 'utf8'), 'video');
    handlers.delvideo({ sender: { send() {} } }, 2);
    assert.equal(context.configVideos.length, 0);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('new tasks with the same manual name get separate output directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-names-test-'));
  try {
    const context = { fs, path, configVideos: [], reservedDownloadDirs: new Set() };
    vm.createContext(context);
    const start = source.indexOf('function taskFileName(');
    const end = source.indexOf('\nfunction playlistFailureMessage(', start);
    vm.runInContext(`${source.slice(start, end)}\nthis.uniqueTaskName = uniqueTaskName;`, context);
    assert.equal(context.uniqueTaskName('My Movie', 1, root), 'My Movie');
    assert.equal(context.uniqueTaskName('My Movie', 2, root), 'My Movie-2');
    assert.equal(context.uniqueTaskName('', 3, root), '3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('segment cleanup preserves unrelated files and removes an empty task directory', () => {
  const start = source.indexOf('function cleanupDownloadedSegments(');
  const end = source.indexOf('\nasync function startDownloadLive(', start);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3u8-cleanup-test-'));
  const segment = path.join(directory, '000001.ts');
  try {
    for (const name of ['000001.ts', '000002.ts.dl', 'aes.key', 'index.txt', 'keep.txt']) {
      fs.writeFileSync(path.join(directory, name), 'test');
    }
    const context = { fs, path };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\nthis.cleanupDownloadedSegments = cleanupDownloadedSegments;`, context);
    context.cleanupDownloadedSegments(directory, [segment]);
    assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
    fs.unlinkSync(path.join(directory, 'keep.txt'));
    context.cleanupDownloadedSegments(directory, []);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
