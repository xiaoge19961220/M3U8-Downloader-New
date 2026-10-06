const { spawn, spawnSync } = require('child_process');

let originalCodePage;
if (process.platform === 'win32') {
  const current = spawnSync('chcp.com', [], { encoding: 'utf8', windowsHide: true });
  originalCodePage = current.stdout && current.stdout.match(/\b\d{3,5}\b/)?.[0];
  spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true });
}

let restored = false;
function restoreCodePage() {
  if (restored || !originalCodePage) return;
  restored = true;
  spawnSync('chcp.com', [originalCodePage], { stdio: 'ignore', windowsHide: true });
}

process.on('exit', restoreCodePage);

const electron = spawn(require('electron'), ['.', ...process.argv.slice(2)], { stdio: 'inherit' });
electron.on('error', error => {
  console.error(`Failed to start Electron: ${error.message}`);
  process.exitCode = 1;
});
electron.on('exit', code => {
  restoreCodePage();
  process.exitCode = code === null ? 1 : code;
});
