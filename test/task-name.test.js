const test = require('node:test');
const assert = require('node:assert/strict');
const { inferTaskName } = require('../resource/js/task-name');

test('video name comes from the playlist filename or meaningful parent directory', () => {
  assert.equal(inferTaskName('https://cdn.example.com/shows/%E7%AC%AC%E4%B8%80%E9%9B%86.m3u8?token=secret'), '第一集');
  assert.equal(inferTaskName('https://cdn.example.com/电影名/index.m3u8'), '电影名');
  assert.equal(inferTaskName('file:///C:/Videos/My%20Movie.m3u8'), 'My Movie');
});

test('generic URLs have no reliable video title', () => {
  assert.equal(inferTaskName('https://cdn.example.com/hls/master.m3u8?token=secret'), '');
  assert.equal(inferTaskName('not a url'), '');
  assert.equal(inferTaskName(''), '');
});

test('suggested names are safe for Windows output files', () => {
  assert.equal(inferTaskName('https://example.com/My%3A%20Movie%3F.m3u8'), 'My Movie');
});
