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
  const start = source.indexOf("ipcMain.on('delvideo'");
  const end = source.indexOf('\nfunction showDirInExploer(', start);
  const calls = [];
  const handlers = {};
  const context = {
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    configVideos: [{ id: 42, dir: 'unused' }],
    cancelTask: id => calls.push(`cancel ${id}`),
    fs: { writeFileSync: () => calls.push('save') },
    globalConfigVideoPath: 'unused',
    logger: {
      info: message => calls.push(message),
      error: error => { throw error; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  handlers.delvideo({ sender: { send: () => calls.push('reply') } }, 42);
  assert.deepEqual(calls, ['cancel 42', 'event=task_delete task_id=42', 'save', 'reply']);
  assert.equal(context.configVideos.length, 0);
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
