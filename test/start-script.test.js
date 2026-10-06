const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'start.js'), 'utf8');

test('Windows launcher sets UTF-8 and restores the original code page', () => {
  const calls = [];
  const electron = new EventEmitter();
  const process = new EventEmitter();
  process.platform = 'win32';
  process.argv = ['node', 'scripts/start.js'];
  const context = {
    process,
    console,
    require(name) {
      if (name === 'electron') return 'electron.exe';
      if (name === 'child_process') return {
        spawnSync(command, args) {
          calls.push(`chcp ${args.join(' ')}`.trim());
          return { stdout: 'Active code page: 936\r\n', status: 0 };
        },
        spawn(command, args) {
          calls.push(`${command} ${args.join(' ')}`);
          return electron;
        }
      };
      throw new Error(`unexpected module: ${name}`);
    }
  };
  vm.runInNewContext(source, context);
  assert.deepEqual(calls, ['chcp', 'chcp 65001', 'electron.exe .']);
  electron.emit('exit', 0);
  process.emit('exit');
  assert.deepEqual(calls, ['chcp', 'chcp 65001', 'electron.exe .', 'chcp 936']);
  assert.equal(process.exitCode, 0);
});
