const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('function normalizeTaskUrl(');
const end = source.indexOf('\nfunction transformConfig(', start);
const context = { URL };
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nthis.urls = { normalizeTaskUrl, resolveSegmentUrl };`, context);

test('segment URLs resolve after whitespace is removed from the playlist address', () => {
  const playlist = context.urls.normalizeTaskUrl('  https://example.com/hls/movie/index.m3u8  ');
  assert.equal(playlist, 'https://example.com/hls/movie/index.m3u8');
  assert.equal(context.urls.resolveSegmentUrl(playlist, ' 624200.ts '), 'https://example.com/hls/movie/624200.ts');
  assert.equal(context.urls.resolveSegmentUrl(playlist, '/segments/624201.ts'), 'https://example.com/segments/624201.ts');
  assert.equal(context.urls.resolveSegmentUrl(playlist, 'https://cdn.example.com/624202.ts'), 'https://cdn.example.com/624202.ts');
});

test('batch task creation trims a pasted playlist URL before downloading', async () => {
  const handlers = {};
  const downloads = [];
  const batchContext = {
    normalizeTaskUrl: context.urls.normalizeTaskUrl,
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    logger: { info() {} },
    startDownload: object => { downloads.push(object.url); }
  };
  vm.createContext(batchContext);
  const handlerStart = source.indexOf("ipcMain.on('task-add-muti'");
  const handlerEnd = source.indexOf('\nclass QueueObject', handlerStart);
  vm.runInContext(source.slice(handlerStart, handlerEnd), batchContext);

  await handlers['task-add-muti']({ sender: { send() {} } }, {
    m3u8_urls: ' https://example.com/hls/index.m3u8 ',
    headers: '',
    taskIsDelTs: true
  });
  assert.deepEqual(downloads, ['https://example.com/hls/index.m3u8']);
});
