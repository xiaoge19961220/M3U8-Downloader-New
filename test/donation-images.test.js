const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');

test('donation images load supported formats from each payment folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donation-images-'));
  try {
    const directory = path.join(root, 'resource', 'alipay');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'b.WEBP'), '');
    fs.writeFileSync(path.join(directory, 'a.png'), '');
    fs.writeFileSync(path.join(directory, 'notes.txt'), '');
    fs.mkdirSync(path.join(directory, 'fake.jpg'));
    const context = { fs, path, pathToFileURL, __dirname: root };
    vm.createContext(context);
    const start = source.indexOf('function donationImages(');
    const end = source.indexOf('\nconst _app = new Vue(', start);
    vm.runInContext(`${source.slice(start, end)}\nthis.donationImages = donationImages;`, context);

    assert.deepEqual(Array.from(context.donationImages('alipay')), [
      pathToFileURL(path.join(directory, 'a.png')).href,
      pathToFileURL(path.join(directory, 'b.WEBP')).href
    ]);
    assert.deepEqual(Array.from(context.donationImages('wechatpay')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
