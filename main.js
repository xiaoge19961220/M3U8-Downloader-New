const os = require('os')
const { app, BrowserWindow, Tray, ipcMain, shell, Menu, dialog, nativeImage } = require('electron');
const isDev = require('electron-is-dev');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const { Parser } = require('m3u8-parser');
const fs = require('fs');
const async = require('async');
const dateFormat = require('dateformat');
const download = require('download');
const crypto = require('crypto');
const got = require('got');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const package_self = require('./package.json');
const appInfo = package_self;
const winston = require('winston');
const nconf = require('nconf');
let ffmpegPath = require('ffmpeg-static');
const contextMenu = require('electron-context-menu');
const Aria2 = require('aria2');
const forever = require('forever-monitor');
const { HttpProxyAgent, HttpsProxyAgent } = require('hpagent');
const url = require('url');
const { inferTaskName } = require('./resource/js/task-name');

contextMenu({ showCopyImage: false, showCopyImageAddress: false, showInspectElement: false, showServices: false });

if (!isDev) {
  ffmpegPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', path.basename(ffmpegPath));
}

let isdelts = true;
let mainWindow = null;
let playerWindow = null;
let tray = null;
let AppTitle = 'M3U8-Downloader'
let firstHide = true;

var configVideos = [];
let globalCond = {};
const activeRequests = new Map();
const activeMerges = new Map();
const activeQueues = new Map();
const activeRuns = new Map();

function trackTaskRequest(id, request) {
  if (!activeRequests.has(id)) activeRequests.set(id, new Set());
  activeRequests.get(id).add(request);
  const release = () => {
    const requests = activeRequests.get(id);
    if (requests) {
      requests.delete(request);
      if (requests.size === 0) activeRequests.delete(id);
    }
  };
  Promise.resolve(request).then(release, release);
  return request;
}

function downloadTaskFile(id, uri, dir, options) {
  return trackTaskRequest(id, download(uri, dir, options));
}

function cancelTask(id) {
  globalCond[id] = false;
  activeRuns.delete(id);
  const queue = activeQueues.get(id);
  if (queue) {
    queue.kill();
    activeQueues.delete(id);
  }
  for (const request of activeRequests.get(id) || []) {
    if (typeof request.cancel === 'function') request.cancel();
    else if (typeof request.destroy === 'function') request.destroy();
  }
  activeRequests.delete(id);
  const merge = activeMerges.get(id);
  if (merge) {
    merge.input.destroy();
    try {
      merge.command.kill('SIGKILL');
    } catch (error) {
      logger.debug(`合并进程已结束: ${error.message}`);
    }
    activeMerges.delete(id);
  }
}
const globalConfigDir = app.getPath('userData');
const globalConfigPath = path.join(globalConfigDir, 'config.json');
const globalConfigVideoPath = path.join(globalConfigDir, 'config_videos.json');
const aria2Dir = path.join(app.getAppPath(), "resource", "aria2", process.platform);
const aria2_app = path.join(aria2Dir, "aria2c.exe");
const aria2_config = path.join(aria2Dir, "aria2.conf");
let aria2Client = null;
let aria2Server = null;
const direct_agent = {
  http: new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 })
};
let proxy_agent = direct_agent;

let globalConfigSaveVideoDir = '';

const httpTimeout = { socket: 600000, request: 600000, response: 600000 };
const DEFAULT_SEGMENT_RETRIES = 9;

function normalizeSegmentRetryCount(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SEGMENT_RETRIES;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 30 ? count : DEFAULT_SEGMENT_RETRIES;
}

function getConfiguredSegmentRetryCount() {
  return normalizeSegmentRetryCount(nconf.get('segment_retry_count'));
}

function normalizeTaskUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function playlistFailureMessage(error) {
  const status = error && error.response && error.response.statusCode;
  if (status === 410) return '视频源请求被服务器拒绝（HTTP 410）；请检查链接、附加头或访问条件';
  if (status === 403) return '视频源拒绝访问（HTTP 403），请检查链接、附加头或登录状态';
  if (status === 404) return '找不到视频源（HTTP 404），请检查 M3U8 链接';
  return error ? `视频源解析失败：${error.message}` : '视频源没有可下载的片段，请检查 M3U8 链接';
}

function resolveSegmentUrl(playlistUrl, segmentUri) {
  return new URL(segmentUri.trim(), normalizeTaskUrl(playlistUrl)).href;
}


function transformConfig(config) {
  const result = []
  for (const [k, v] of Object.entries(config)) {
    if (v !== '') {
      result.push(`--${k}=${v}`)
    }
  }
  return result
}



// 单例应用程序
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}

app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu-rasterization')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('--no-sandbox')
app.disableHardwareAcceleration();
app.on('second-instance', (event, argv, cwd) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else if (mainWindow.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  } else {
    app.quit()
  }
})

const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}` + (info.splat !== undefined ? `${info.splat}` : " "))
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(globalConfigDir, 'logs/error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(globalConfigDir, 'logs/all.log') }),
  ],
});

if (!fs.existsSync(globalConfigDir)) {
  fs.mkdirSync(globalConfigDir, { recursive: true });
}

nconf.argv().env()
try {
  nconf.file({ file: globalConfigPath })
} catch (error) {
  logger.error('Please correct the mistakes in your configuration file: [%s].\n' + error, configFilePath)
}


process.on('uncaughtException', (err, origin) => {
  logger.error(`uncaughtException: ${err} | ${origin}`)
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`unhandledRejection: ${promise} | ${reason}`)
});

logger.info(`\n\n----- ${appInfo.name} | v${appInfo.version} | ${os.platform()} -----\n\n`)
logger.info(`event=app_open version=${appInfo.version} platform=${os.platform()}`);

function createWindow() {
  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 600,
    skipTaskbar: false,
    transparent: false, frame: false, resizable: true,
    webPreferences: {
      nodeIntegration: true,
      spellcheck: false,
      contextIsolation: false,
      webSecurity: !isDev
    },
    icon: path.join(__dirname, 'resource/icon/logo.png'),
    alwaysOnTop: false,
    hasShadow: false,
  });
  mainWindow.setMenu(null)
  // 加载index.html文件
  mainWindow.loadFile(path.join(__dirname, 'start.html'));
  isDev && mainWindow.openDevTools();
  // 当 window 被关闭，这个事件会被触发。
  mainWindow.on('closed', () => {
    // 取消引用 window 对象，如果你的应用支持多窗口的话，
    // 通常会把多个 window 对象存放在一个数组里面，
    // 与此同时，你应该删除相应的元素。
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });
}
function createPlayerWindow(src) {
  logger.info('event=player_open');
  if (playerWindow == null) {
    // 创建浏览器窗口
    playerWindow = new BrowserWindow({
      width: 1024,
      height: 600,
      skipTaskbar: false,
      transparent: false, frame: false, resizable: true,
      webPreferences: {
        nodeIntegration: true
      },
      icon: path.join(__dirname, 'resource/icon/logo.png'),
      alwaysOnTop: false,
      hasShadow: false,
      parent: mainWindow
    });
    playerWindow.setMenu(null)
    playerWindow.on('closed', () => {
      // 取消引用 window 对象，如果你的应用支持多窗口的话，
      // 通常会把多个 window 对象存放在一个数组里面，
      // 与此同时，你应该删除相应的元素。
      logger.info('playerWindow close.')
      playerWindow = null;
    })
  }
  // 加载index.html文件
  playerWindow.loadFile(path.join(__dirname, 'player.html'), { search: "src=" + src });
}

function loadConfigVideos() {
  if (!fs.existsSync(globalConfigVideoPath)) return [];
  try {
    const videos = JSON.parse(fs.readFileSync(globalConfigVideoPath, 'utf8'));
    if (Array.isArray(videos)) return videos;
    throw new Error('config_videos.json must contain an array');
  } catch (error) {
    logger.error(`读取下载记录失败: ${error.message}`);
    return [];
  }
}
app.on('ready', () => {

  createWindow();
  let iconImg = nativeImage.createFromPath(path.join(__dirname, 'resource', 'icon', 'logo.png'));
  tray = new Tray(iconImg.resize({ width: 20, height: 20 }));
  tray.setTitle(AppTitle);
  tray.setToolTip(AppTitle);
  tray.on("double-click", () => {
    mainWindow.show();
  });
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      type: 'normal',
      click: () => {
        mainWindow.show();
      }
    },
    {
      type: 'separator'
    },
    {
      label: '退出',
      type: 'normal',
      click: () => {

        aria2Server && aria2Server.stop();
        if (playerWindow) {
          playerWindow.close();
        }
        mainWindow.close();
        setTimeout(() => { app.quit() }, 2000);
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  configVideos = loadConfigVideos();
  for (const video of configVideos) {
    globalCond[video.id] = false;
    if (video.completed == null) video.completed = Boolean(video.status === '已完成' && video.videopath && fs.existsSync(video.videopath));
    video.paused = !video.completed;
  }

  globalConfigSaveVideoDir = nconf.get('SaveVideoDir');

  const config_proxy = nconf.get('config_proxy');
  proxy_agent = config_proxy ? {
    http: new HttpProxyAgent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 256,
      maxFreeSockets: 256,
      scheduling: 'lifo',
      proxy: config_proxy
    }),
    https: new HttpsProxyAgent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 256,
      maxFreeSockets: 256,
      scheduling: 'lifo',
      proxy: config_proxy
    })
  } : direct_agent;

  return;

  const EMPTY_STRING = '';
  const systemConfig = {
    'all-proxy': EMPTY_STRING,
    'allow-overwrite': false,
    'auto-file-renaming': true,
    'check-certificate': false,
    'continue': false,
    'dir': app.getPath('downloads'),
    'max-concurrent-downloads': 120,
    'max-connection-per-server': 5,
    'max-download-limit': 0,
    'max-overall-download-limit': 0,
    'max-overall-upload-limit': '256K',
    'min-split-size': '1M',
    'no-proxy': EMPTY_STRING,
    'pause': true,
    'rpc-listen-port': 16801,
    'rpc-secret': EMPTY_STRING,
    'seed-ratio': 1,
    'seed-time': 60,
    'split': 10,
    'user-agent': 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36Transmission/2.94'
  }

  let cmds = [aria2_app, `--conf-path=${aria2_config}`];
  cmds = [...cmds, ...transformConfig(systemConfig)];
  logger.debug(cmds.join(' '));

  let instance = forever.start(cmds, {
    max: 10,
    parser: function (command, args) {
      logger.debug(command, args);
      return {
        command: command,
        args: args
      }
    },
    silent: false
  });
  instance.on('start', function (process, data) {
    let aria2 = new Aria2({ port: 16801 });
    aria2.open();
    aria2.on('close', (e) => {
      console.log('----aria2 connect close----');
      setTimeout(() => aria2.open(), 100);
    });
    aria2.on("onDownloadComplete", downloadComplete);
    aria2Client = aria2;

    setInterval(() => {
      aria2Client.call('getGlobalStat').then((result) => {
        if (result && result['downloadSpeed']) {
          var _speed = '';
          var speed = parseInt(result['downloadSpeed']);
          _speed = (speed < 1024 * 1024) ? Math.round(speed / 1024) + ' KB/s' : (speed / 1024 / 1024).toFixed(2) + ' MiB/s'
          mainWindow.webContents.send('notify-download-speed', _speed);
        }
      });
    }, 1500);
  });
  aria2Server = instance;
});

function downloadComplete(e) {
  console.log('---- aria2 downloadComplete ----');
  var gid = e[0]['gid'];

  console.log(gid);
}

// 当全部窗口关闭时退出。
app.on('window-all-closed', () => {

  logger.info('event=app_close');

  // 在 macOS 上，除非用户用 Cmd + Q 确定地退出，
  // 否则绝大部分应用及其菜单栏会保持激活。
  if (process.platform !== 'darwin') {
    tray && tray.destroy();
    tray = null;
    app.quit();
  };
})

app.on('activate', () => {
  // 在macOS上，当单击dock图标并且没有其他窗口打开时，
  // 通常在应用程序中重新创建一个窗口。
  if (mainWindow === null) {
    createWindow()
  }
  else {
    mainWindow.show();
  }
})

ipcMain.on("hide-windows", function () {
  if (mainWindow != null) {
    mainWindow.hide();

    if (firstHide && tray) {
      tray.displayBalloon({
        icon: path.join(__dirname, 'resource/icon/logo-512.png'),
        title: "提示",
        content: "我隐藏到这里了哦，双击我显示主窗口！"
      });
      firstHide = false;
    }
  }
});

ipcMain.on('get-version', function (event, arg) {
  event.sender.send('get-version-reply', package_self.version);
});

ipcMain.on('get-all-videos', function (event, arg) {

  event.sender.send('get-all-videos-reply', configVideos);
});

ipcMain.on('open-log-dir', function (event, arg) {
  showDirInExploer(path.join(globalConfigDir, 'logs'))
});

ipcMain.on('task-clear', async function (event, object) {
  logger.info(`event=tasks_clear count=${configVideos.length}`);
  configVideos.forEach((video) => {
    cancelTask(video.id);
  })
  const failed = [];
  for (const video of configVideos) {
    try {
      removeTaskDownloads(video, []);
    } catch (error) {
      logger.error(`event=task_delete_failed task_id=${video.id} error=${error.message}`);
      failed.push(video);
    }
  }
  configVideos = failed;
  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
  event.sender.send('task-clear-reply', configVideos);
});

ipcMain.on('task-add', async function (event, object) {
  logger.info('event=task_add source=single');
  let hlsSrc = normalizeTaskUrl(object.url);
  object.url = hlsSrc;
  if (!object.taskName || !object.taskName.trim()) object.taskName = inferTaskName(hlsSrc);
  let _headers = {};
  if (object.headers) {
    let __ = object.headers.match(/(.*?): ?(.*?)(\n|\r|$)/g);
    __ && __.forEach((_) => {
      let ___ = _.match(/(.*?): ?(.*?)(\n|\r|$)/i);
      ___ && (_headers[___[1]] = ___[2]);
    });
  }

  let mes = hlsSrc.match(/^https?:\/\/[^/]*/);
  let _hosts = '';
  if (mes && mes.length >= 1) {
    _hosts = mes[0];

    if (_headers['Origin'] == null && _headers['origin'] == null) {
      _headers['Origin'] = _hosts;
    }
    if (_headers['Referer'] == null && _headers['referer'] == null) {
      _headers['Referer'] = _hosts;
    }
  }

  object.headers = _headers;

  let info = '解析资源失败！';
  let code = -1;
  let playlistError = null;

  let parser = new Parser();
  if (/^file:\/\/\//g.test(hlsSrc)) {
    parser.push(fs.readFileSync(hlsSrc.replace(/^file:\/\/\//g, '')));
    parser.end();
  }
  else {
    for (let index = 0; index < 3; index++) {
      logger.info(`got ${hlsSrc} index:${index}`);
      let response = await got(hlsSrc, {
        headers: _headers, timeout: httpTimeout, agent: proxy_agent, https: {
          rejectUnauthorized: false
        }
      }).catch(error => {
        playlistError = error;
        logger.error(error);
      });
      if (playlistError && playlistError.response && playlistError.response.statusCode === 410) break;
      {
        if (response && response.body != null
          && response.body != '') {
          parser.push(response.body);
          parser.end();

          if ((!parser.manifest.segments || !parser.manifest.segments.length)
            && parser.manifest.playlists && parser.manifest.playlists.length) {
            hlsSrc = url.resolve(hlsSrc, parser.manifest.playlists[0].uri);
            logger.info(`redirect ${parser.manifest.playlists[0].uri} to ${hlsSrc} index:${index}`);
            object.url = hlsSrc;
            parser = new Parser();
            index = 0;
            continue;
          }
          break;
        }
      }
    }
  }

  let count_seg = (parser.manifest.segments || []).length;
  if (count_seg > 0) {
    code = 0;
    if (parser.manifest.endList) {
      let duration = 0;
      parser.manifest.segments.forEach(segment => {
        duration += segment.duration;
      });
      info = `点播资源解析成功，有 ${count_seg} 个片段，时长：${formatTime(duration)}，即将开始缓存...`;
      startDownload(object, undefined, parser.manifest);
    }
    else {
      info = `直播资源解析成功，即将开始缓存...`;
      startDownloadLive(object, parser.manifest);
    }
  }
  else if (parser.manifest.playlists && parser.manifest.playlists.length && parser.manifest.playlists.length >= 1) {
    code = 1;
    event.sender.send('task-add-reply', { code: code, message: '', playlists: parser.manifest.playlists });
    return;
  }
  else {
    info = playlistFailureMessage(playlistError);
  }
  event.sender.send('task-add-reply', { code: code, message: info });
});


ipcMain.on('task-add-muti', async function (event, object) {
  let m3u8_urls = object.m3u8_urls;
  let _headers = {};
  if (object.headers) {
    let __ = object.headers.match(/(.*?): ?(.*?)(\n|\r|$)/g);
    __ && __.forEach((_) => {
      let ___ = _.match(/(.*?): ?(.*?)(\n|\r|$)/i);
      ___ && (_headers[___[1]] = ___[2]);
    });
  }

  let info = '解析资源失败！';
  let code = -1;
  let iidx = 0;
  m3u8_urls.split(/\r|\n/g).forEach(urls => {
    if (urls != '') {
      let _obj = {
        url: '',
        headers: object.headers,
        myKeyIV: '',
        taskName: '',
        taskIsDelTs: object.taskIsDelTs,
        url_prefix: ''
      };
      if (/-{4}/.test(urls)) {
        let __ = urls.split('----');
        if (__ && __.length >= 2) {
          if (__[0]) {
            _obj.url = __[0];
            if (__[1]) {
              _obj.taskName = __[1];
            }
          }
        }
      }
      else {
        _obj.url = urls;
      }

      _obj.url = normalizeTaskUrl(_obj.url);
      if (_obj.url) {

        let mes = _obj.url.match(/^https?:\/\/[^/]*/);
        let _hosts = '';
        if (mes && mes.length >= 1) {
          _hosts = mes[0];

          if (_headers['Origin'] == null && _headers['origin'] == null) {
            _headers['Origin'] = _hosts;
          }
          if (_headers['Referer'] == null && _headers['referer'] == null) {
            _headers['Referer'] = _hosts;
          }
        }

        _obj.headers = _headers;

        startDownload(_obj, iidx);
        iidx = iidx + 1;
      }
    }
  })
  logger.info(`event=task_add source=batch count=${iidx}`);
  info = `批量添加成功，正在下载...`;
  event.sender.send('task-add-reply', { code: 0, message: info });
});

class QueueObject {
  constructor() {
    this.segment = null;
    this.url = '';
    this.url_prefix = '';
    this.headers = '';
    this.myKeyIV = '';
    this.id = 0;
    this.idx = 0;
    this.dir = '';
    this.then = this.catch = null;
    this.retry = 0;
    this.maxRetries = DEFAULT_SEGMENT_RETRIES;
    this.isActive = () => Boolean(globalCond[this.id]);
  }
  async callback(_callback) {
    try {
      this.retry = this.retry + 1;
      if (this.retry > this.maxRetries + 1) {
        this.catch && this.catch();
        return;
      }
      if (!this.isActive()) {
        logger.debug(`globalCond[this.id] is not exsited.`);
        return;
      }

      let partent_uri = this.url.replace(/([^\/]*\?.*$)|([^\/]*$)/g, '');
      let segment = this.segment;
      let uri_ts = '';
      if (/^https?:\/\//i.test(this.url) || /^https?:\/\//i.test(segment.uri.trim())) {
        uri_ts = resolveSegmentUrl(this.url, segment.uri);
      }
      else if (/^file:\/\/\//.test(this.url) && !this.url_prefix) {
        let fileDir = this.url.replace('file:///', '').replace(/[^\\/]{1,}$/, '');
        uri_ts = path.join(fileDir, segment.uri);
        if (!fs.existsSync(uri_ts)) {
          var me = segment.uri.match(/[^\\\/\?]{1,}\?|$/i);
          if (me && me.length > 1) {
            uri_ts = path.join(fileDir, me[0].replace(/\?$/, ''));
          }
          if (!fs.existsSync(uri_ts)) {
            globalCond[this.id] = false;
            this.catch && this.catch();
            return;
          }
        }
        uri_ts = "file:///" + uri_ts
      }
      else if (/^file:\/\/\//.test(this.url) && this.url_prefix) {
        uri_ts = this.url_prefix + (this.url_prefix.endsWith('/') || segment.uri.startsWith('/') ? '' : "/") + segment.uri;
      }

      let filename = `${((this.idx + 1) + '').padStart(6, '0')}.ts`;
      let filpath = path.join(this.dir, filename);
      let filpath_dl = path.join(this.dir, filename + ".dl");

      logger.debug(`2 ${segment.uri}`, `${filename}`);

      //检测文件是否存在
      // One request per queue run keeps the configured retry count exact.
      for (let index = 0; index < 1 && this.isActive() && !fs.existsSync(filpath); index++) {
        // 下载的时候使用.dl后缀的文件名，下载完成后重命名
        let that = this;

        if (/^file:\/\/\//.test(uri_ts)) {
          fs.copyFileSync(uri_ts.replace(/^file:\/\/\//, ''), filpath_dl);
        }
        else {

          var _headers = [];
          if (that.headers) {
            for (var _key in that.headers) {
              _headers.push(_key + ": " + that.headers[_key])
            }
          }
          //aria2Client && aria2Client.call("addUri", [uri_ts], { dir:that.dir, out: filename + ".dl", split: "16", header: _headers});
          //break;
          await downloadTaskFile(this.id, uri_ts, that.dir, { filename: filename + ".dl", timeout: httpTimeout, headers: that.headers, agent: proxy_agent }).catch((err) => {
            if (this.isActive()) {
              logger.error(err);
              if (fs.existsSync(filpath_dl)) fs.unlinkSync(filpath_dl);
            }
          });
        }
        if (!this.isActive()) {
          if (activeRuns.has(this.id)) return;
          if (fs.existsSync(filpath_dl)) fs.unlinkSync(filpath_dl);
          return;
        }
        if (!fs.existsSync(filpath_dl)) continue;
        if (fs.statSync(filpath_dl).size <= 0) {
          fs.unlinkSync(filpath_dl);
        }

        if (segment.key != null && segment.key.method != null) {
          //标准解密TS流
          let aes_path = path.join(this.dir, "aes.key");
          if (!this.myKeyIV && !fs.existsSync(aes_path)) {
            let key_uri = segment.key.uri;
            if (/^http/.test(this.url) && !/^http.*/.test(key_uri) && !/^\/.*/.test(key_uri)) {
              key_uri = partent_uri + key_uri;
            }
            else if (/^http/.test(this.url) && /^\/.*/.test(key_uri)) {
              let mes = this.url.match(/^https?:\/\/[^/]*/);
              if (mes && mes.length >= 1) {
                key_uri = mes[0] + key_uri;
              }
              else {
                key_uri = partent_uri + key_uri;
              }
            }
            else if (/^file:\/\/\//.test(this.url) && !this.url_prefix && !/^http.*/.test(key_uri)) {
              let fileDir = this.url.replace('file:///', '').replace(/[^\\/]{1,}$/, '');
              let key_uri_ = path.join(fileDir, key_uri);
              if (!fs.existsSync(key_uri_)) {
                var me = key_uri.match(/([^\\\/\?]{1,})(\?|$)/i);
                if (me && me.length > 1) {
                  key_uri_ = path.join(fileDir, me[1]);
                }
                if (!fs.existsSync(key_uri_)) {
                  globalCond[this.id] = false;
                  this.catch && this.catch();
                  return;
                }
              }
              key_uri = "file:///" + key_uri_;
            }
            else if (/^file:\/\/\//.test(this.url) && this.url_prefix && !/^http.*/.test(key_uri)) {
              key_uri = this.url_prefix + (this.url_prefix.endsWith('/') || key_uri.startsWith('/') ? '' : "/") + key_uri;
            }

            if (/^http/.test(key_uri)) {
              await downloadTaskFile(this.id, key_uri, that.dir, { filename: "aes.key", headers: that.headers, timeout: httpTimeout, agent: proxy_agent }).catch((error) => {
                if (this.isActive()) logger.error(error);
              });
              if (!this.isActive()) return;
            }
            else if (/^file:\/\/\//.test(key_uri)) {
              key_uri = key_uri.replace('file:///', '')
              if (fs.existsSync(key_uri)) {
                fs.copyFileSync(key_uri, aes_path);
              }
              else {
                globalCond[this.id] = false;
                this.catch && this.catch();
                return;
              }
            }
          }
          if (this.myKeyIV || fs.existsSync(aes_path)) {
            try {
              let key_ = null;
              let iv_ = null;
              if (!this.myKeyIV) {
                key_ = fs.readFileSync(aes_path);
                if (key_.length == 32) {
                  key_ = Buffer.from(fs.readFileSync(aes_path, { encoding: 'utf8' }), 'hex');
                }
                iv_ = segment.key.iv != null ? Buffer.from(segment.key.iv.buffer)
                  : Buffer.from(that.idx.toString(16).padStart(32, '0'), 'hex');
              }
              else {

                key_ = Buffer.from(this.myKeyIV.substr(0, 32), 'hex');
                if (this.myKeyIV.length >= 64) {
                  iv_ = Buffer.from(this.myKeyIV.substr(this.myKeyIV.length - 32, 32), 'hex');
                }
                else {
                  iv_ = Buffer.from(that.idx.toString(16).padStart(32, '0'), 'hex')
                }
              }
              logger.debug(`key:${key_.toString('hex')} | iv:${iv_.toString('hex')}`)
              let cipher = crypto.createDecipheriv((segment.key.method + "-cbc").toLowerCase(), key_, iv_);
              cipher.on('error', console.error);
              let inputData = fs.readFileSync(filpath_dl);
              let outputData = Buffer.concat([cipher.update(inputData), cipher.final()]);
              fs.writeFileSync(filpath, outputData);

              if (fs.existsSync(filpath_dl))
                fs.unlinkSync(filpath_dl);

              that.then && that.then();
            } catch (error) {
              logger.error(error)
              if (fs.existsSync(filpath_dl))
                fs.unlinkSync(filpath_dl);
            }
            return;
          }
        }
        else {
          fs.renameSync(filpath_dl, filpath);
          break;
        }
      }
      if (!this.isActive()) return;
      if (fs.existsSync(filpath)) {
        this.then && this.then();
      }
      else {
        this.catch && this.catch();
      }
    }
    catch (e) {
      logger.error(e);
      if (this.isActive()) this.catch && this.catch();
    }
    finally {
      _callback();
    }
  }
}

function queue_callback(that, callback) {
  that.callback(callback);
}

function scanDownloadedSegments(dir, count) {
  const missing = [];
  let downloaded = 0;
  for (let index = 0; index < count; index++) {
    const file = path.join(dir, `${(index + 1 + '').padStart(6, '0')}.ts`);
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 0) {
        downloaded++;
        continue;
      }
      fs.unlinkSync(file);
    }
    missing.push(index);
  }
  return { downloaded, missing };
}

async function startDownload(object, iidx, initialManifest) {
  const resuming = Boolean(object.id);
  let id = !object.id ? (iidx != null ? (new Date().getTime() + iidx) : new Date().getTime()) : object.id;
  globalCond[id] = true;
  const run = Symbol('vod-download');
  activeRuns.set(id, run);
  const isActive = () => globalCond[id] && activeRuns.get(id) === run;
  let headers = object.headers;
  let url_prefix = object.url_prefix;
  let taskName = object.taskName;
  let myKeyIV = object.myKeyIV;
  let url_src = normalizeTaskUrl(object.url);
  let taskIsDelTs = object.taskIsDelTs;
  if (!taskName || !taskName.trim()) taskName = inferTaskName(url_src) || `${id}`;
  let dir = path.join(app.getAppPath().replace(/resources\\app.asar$/g, ""), 'download/' + taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, ""));
  if (globalConfigSaveVideoDir) {
    dir = path.join(globalConfigSaveVideoDir, taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, ""))
  }
  if (resuming && object.dir) dir = object.dir;

  logger.info(`event=download_start task_id=${id} mode=vod output_dir=${JSON.stringify(dir)}`);


  let parser = initialManifest ? { manifest: initialManifest } : new Parser();
  let playlistError = null;
  if (initialManifest) {
    logger.info(`event=playlist_reused task_id=${id} segments=${(initialManifest.segments || []).length}`);
  }
  else if (/^file:\/\/\//g.test(url_src)) {
    parser.push(fs.readFileSync(url_src.replace(/^file:\/\/\//, '')));
    parser.end();
  }
  else {
    for (let index = 0; index < 3; index++) {
      let response = await trackTaskRequest(id, got(url_src, {
        headers: headers, timeout: httpTimeout, agent: proxy_agent, https: {
          rejectUnauthorized: false
        }
      })).catch(error => {
        playlistError = error;
        if (isActive()) logger.error(error);
      });
      if (!isActive()) return;
      if (playlistError && playlistError.response && playlistError.response.statusCode === 410) break;
      {
        if (response && response.body != null
          && response.body != '') {
          parser.push(response.body);
          parser.end();

          if ((!parser.manifest.segments || !parser.manifest.segments.length)
            && parser.manifest.playlists && parser.manifest.playlists.length) {
            url_src = url.resolve(url_src, parser.manifest.playlists[0].uri);
            logger.info(`redirect ${parser.manifest.playlists[0].uri} to ${url_src} index:${index}`);
            index = 0;
            parser = new Parser();
            continue;
          }
          break;
        }
      }
    }
  }

  const playlistSegments = parser.manifest.segments || [];
  if (!playlistSegments.length) {
    const message = playlistFailureMessage(playlistError);
    globalCond[id] = false;
    activeRuns.delete(id);
    const failedVideo = resuming ? object : {
      id, url: url_src, url_prefix, dir, time: dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss"),
      isLiving: false, headers, taskName, myKeyIV, taskIsDelTs, videopath: '',
      segment_total: 0, segment_downloaded: 0
    };
    failedVideo.success = false;
    failedVideo.paused = true;
    failedVideo.completed = false;
    failedVideo.status = message;
    if (!resuming) configVideos.splice(0, 0, failedVideo);
    fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
    mainWindow && mainWindow.webContents.send(resuming ? 'task-notify-update' : 'task-notify-create', failedVideo);
    logger.error(`event=playlist_failed task_id=${id} message=${JSON.stringify(message)}`);
    return;
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  //并发 2 个线程下载
  var tsQueues = async.queue(queue_callback, 10);
  activeQueues.set(id, tsQueues);

  let count_seg = (parser.manifest.segments || []).length;
  logger.info(`event=playlist_parsed task_id=${id} segments=${count_seg}`);
  let count_downloaded = 0;
  var video = resuming ? object : {
    id: id,
    url: url_src,
    url_prefix: url_prefix,
    dir: dir,
    segment_total: count_seg,
    segment_downloaded: count_downloaded,
    time: dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss"),
    status: '初始化...',
    isLiving: false,
    headers: headers,
    taskName: taskName,
    myKeyIV: myKeyIV,
    taskIsDelTs: taskIsDelTs,
    success: true,
    videopath: '',
    paused: false,
    completed: false
  };
  video.url = url_src;
  video.dir = dir;
  video.segment_total = count_seg;
  video.segment_downloaded = 0;
  video.success = true;
  video.paused = false;
  video.completed = false;
  video.status = '正在检查已下载片段...';
  if (!resuming) configVideos.splice(0, 0, video);
  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));

  if (!object.id) {
    mainWindow && mainWindow.webContents.send('task-notify-create', video);
  }
  let segments = parser.manifest.segments;
  const maxRetries = getConfiguredSegmentRetryCount();
  logger.info(`event=download_retry_policy task_id=${id} retries=${maxRetries}`);
  const scan = scanDownloadedSegments(dir, segments.length);
  count_downloaded = scan.downloaded;
  const missingSegments = scan.missing;
  video.segment_downloaded = count_downloaded;
  video.status = `下载中...${count_downloaded}/${count_seg}`;
  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
  mainWindow && mainWindow.webContents.send('task-notify-update', video);
  logger.info(`event=download_resume_scan task_id=${id} reused=${count_downloaded} remaining=${missingSegments.length}`);
  for (const iSeg of missingSegments) {
    let qo = new QueueObject();
    qo.dir = dir;
    qo.idx = iSeg;
    qo.id = id;
    qo.isActive = isActive;
    qo.url = url_src;
    qo.url_prefix = url_prefix;
    qo.headers = headers;
    qo.myKeyIV = myKeyIV;
    qo.segment = segments[iSeg];
    qo.maxRetries = maxRetries;
    qo.then = function () {
      if (!isActive()) return;
      count_downloaded = count_downloaded + 1
      video.segment_downloaded = count_downloaded;
      video.status = `下载中...${count_downloaded}/${count_seg}`
      if (video.success) {
        mainWindow.webContents.send('task-notify-update', video);
      }
    };
    qo.catch = function () {
      if (!isActive()) return;
      if (this.retry <= this.maxRetries) {
        tsQueues.push(this);
      }
      else {
        globalCond[id] = false;
        activeRuns.delete(id);
        video.success = false;
        video.paused = true;

        logger.error(`event=download_failed task_id=${id} segment=${JSON.stringify(this.segment.uri)} attempts=${this.retry} retries=${this.maxRetries}`);
        video.status = `下载片段失败（已尝试 ${this.retry} 次）`;
        mainWindow.webContents.send('task-notify-end', video);

        fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
      }
    }
    tsQueues.push(qo);
  }
  const finishDownload = async () => {
    if (!isActive() || !video.success || !configVideos.includes(video)) {
      return;
    }
    activeQueues.delete(id);

    logger.info(`event=segments_downloaded task_id=${id} segments=${count_downloaded}`);
    video.status = "已完成，合并中...";
    mainWindow.webContents.send('task-notify-end', video);
    let fileSegments = [];
    for (let iSeg = 0; iSeg < segments.length; iSeg++) {
      let filpath = path.join(dir, `${((iSeg + 1) + '').padStart(6, '0')}.ts`);
      if (fs.existsSync(filpath)) {
        fileSegments.push(filpath);
      }
    }
    if (!fileSegments.length) {
      video.status = "下载失败，请检查链接有效性";
      mainWindow.webContents.send('task-notify-end', video);
      logger.error(`[${url_src}] 下载失败，请检查链接有效性`);
      return;
    }
    let outPathMP4 = path.join(dir, taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, "") + '.mp4');
    let outPathMP4_ = path.join(globalConfigSaveVideoDir, taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, "") + '.mp4');
    if (fs.existsSync(ffmpegPath)) {
      if (fs.existsSync(outPathMP4)) fs.unlinkSync(outPathMP4);
      logger.info(`event=merge_start task_id=${id} source=download segments=${fileSegments.length}`);
      let ffmpegInputStream = createSegmentStream(fileSegments, (completed, total) => {
        let percent = Number.parseInt(completed * 100 / total);
        video.status = `合并中[${percent}%]`;
        mainWindow.webContents.send('task-notify-end', video);
      });
      const mergeCommand = new ffmpeg(ffmpegInputStream)
        .setFfmpegPath(ffmpegPath)
        .videoCodec('copy')
        .audioCodec('copy')
        .format('mp4')
        .save(outPathMP4)
        .on('error', (error) => {
          activeMerges.delete(id);
          if (!isActive()) return;
          logger.error(`event=merge_failed task_id=${id} message=${JSON.stringify(error.message)}`);
          logger.error(error)
          video.videopath = "";
          video.paused = true;
          globalCond[id] = false;
          activeRuns.delete(id);
          video.status = "合并出错，请尝试手动合并";
          mainWindow.webContents.send('task-notify-end', video);

          fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
        })
        .on('end', function () {
          activeMerges.delete(id);
          if (!isActive()) return;
          video.videopath = "";
          fs.existsSync(outPathMP4) && (fs.renameSync(outPathMP4, outPathMP4_), video.videopath = outPathMP4_);
          logger.info(`event=merge_complete task_id=${id} output=${JSON.stringify(video.videopath || outPathMP4)}`);
          video.completed = true;
          video.paused = false;
          globalCond[id] = false;
          activeRuns.delete(id);
          video.status = "已完成"
          mainWindow.webContents.send('task-notify-end', video);
          if (video.taskIsDelTs) {
            try {
              cleanupDownloadedSegments(dir, fileSegments);
            } catch (error) {
              logger.warn(`清理临时片段失败: ${error.message}`);
            }
          }
          fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
        })
        .on('progress', (info) => {
          logger.info(JSON.stringify(info));
        });
      activeMerges.set(id, { command: mergeCommand, input: ffmpegInputStream });

    }
    else {
      video.videopath = outPathMP4;
      video.status = "已完成，未发现本地FFMPEG，不进行合成。"
      mainWindow.webContents.send('task-notify-end', video);
    }
  };
  tsQueues.drain(finishDownload);
  if (missingSegments.length === 0) void finishDownload();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class FFmpegStreamReadable extends Readable {
  constructor(opt) {
    super(opt);
  }
  _read() { }
}

function createSegmentStream(files, onSegment) {
  return Readable.from((async function* () {
    for (let index = 0; index < files.length; index++) {
      yield* fs.createReadStream(files[index]);
      if (onSegment) onSegment(index + 1, files.length);
    }
  })(), { objectMode: false });
}

function cleanupDownloadedSegments(dir, fileSegments) {
  for (const file of fileSegments) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.txt' || name === 'aes.key' || /^\d{6}\.ts\.dl$/.test(name)) {
      fs.unlinkSync(path.join(dir, name));
    }
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

async function startDownloadLive(object, initialManifest) {
  const resuming = Boolean(object.id);
  let id = !object.id ? new Date().getTime() : object.id;
  let headers = object.headers;
  let taskName = object.taskName;
  let myKeyIV = object.myKeyIV;
  let url = normalizeTaskUrl(object.url);
  const maxRetries = getConfiguredSegmentRetryCount();
  if (!taskName || !taskName.trim()) taskName = inferTaskName(url) || `${id}`;
  let dir = path.join(app.getAppPath().replace(/resources\\app.asar$/g, ""), 'download/' + taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, ""));
  if (globalConfigSaveVideoDir) {
    dir = path.join(globalConfigSaveVideoDir, taskName.replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, ""))
  }
  if (resuming && object.dir) dir = object.dir;
  logger.info(`event=download_start task_id=${id} mode=live output_dir=${JSON.stringify(dir)}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let count_downloaded = 0;
  let count_seg = 100;
  var video = resuming ? object : {
    id: id,
    url: url,
    dir: dir,
    segment_total: count_seg,
    segment_downloaded: count_downloaded,
    time: dateFormat(new Date(), "yyyy-mm-dd HH:MM:ss"),
    status: '初始化...',
    isLiving: true,
    myKeyIV: myKeyIV,
    taskName: taskName,
    headers: headers,
    videopath: '',
    paused: false,
    completed: false
  };

  video.paused = false;
  video.completed = false;
  if (!resuming) configVideos.splice(0, 0, video);
  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));

  if (!object.id) {
    mainWindow.webContents.send('task-notify-create', video);
  }

  let segmentSet = new Set();
  let nextLiveSegmentFile = 0;
  let ffmpegInputStream = null;
  let ffmpegObj = null;
  globalCond[id] = true;
  while (globalCond[id]) {

    try {
      let manifest = initialManifest;
      initialManifest = null;
      if (!manifest) {
        const response = await trackTaskRequest(id, got(url, {
          headers: headers, timeout: httpTimeout, agent: proxy_agent, https: {
            rejectUnauthorized: false
          }
        })).catch(error => {
          if (globalCond[id]) logger.error(error);
        });
        if (!globalCond[id]) break;
        if (response == null || response.body == null || response.body == '') break;
        let parser = new Parser();
        parser.push(response.body);
        parser.end();
        manifest = parser.manifest;
      }

      let count_seg = manifest.segments.length;
      let segments = manifest.segments;
      logger.info(`解析到 ${count_seg} 片段`)
      if (count_seg > 0) {
        //开始下载片段的时间，下载完毕后，需要计算下次请求的时间
        let _startTime = new Date();
        let _videoDuration = 0;
        const newSegments = [];
        const seen = new Set();
        for (const segment of segments) {
          if (!segmentSet.has(segment.uri) && !seen.has(segment.uri)) {
            newSegments.push(segment);
            seen.add(segment.uri);
          }
        }

        const pending = new Map();
        let nextToFetch = 0;
        const discardPending = () => {
          for (const promise of pending.values()) {
            promise.then(file => {
              if (file && fs.existsSync(file)) fs.unlinkSync(file);
            }).catch(logger.error);
          }
          pending.clear();
        };
        const prefetch = () => {
          while (globalCond[id] && pending.size < 4 && nextToFetch < newSegments.length) {
            const segment = newSegments[nextToFetch++];
            const filename = `${(++nextLiveSegmentFile + '').padStart(6, '0')}.ts`;
            const filpath = path.join(dir, filename);
            const filpath_dl = filpath + '.dl';
            const uri_ts = new URL(segment.uri, url).href;
            pending.set(segment.uri, (async () => {
              for (let attempt = 0; attempt <= maxRetries && globalCond[id]; attempt++) {
                try {
                  await downloadTaskFile(id, uri_ts, dir, {
                    filename: filename + '.dl', timeout: httpTimeout, headers: headers, agent: proxy_agent
                  });
                  if (!globalCond[id]) break;
                  if (fs.existsSync(filpath_dl) && fs.statSync(filpath_dl).size > 0) {
                    fs.renameSync(filpath_dl, filpath);
                    return filpath;
                  }
                } catch (error) {
                  if (globalCond[id]) logger.error(error);
                }
                if (fs.existsSync(filpath_dl)) fs.unlinkSync(filpath_dl);
              }
              return null;
            })());
          }
        };

        prefetch();
        for (const segment of newSegments) {
          if (!globalCond[id]) {
            discardPending();
            break;
          }
          _videoDuration += (Number(segment.duration) || 0) * 1000;
          const filpath = await pending.get(segment.uri);
          pending.delete(segment.uri);
          if (!globalCond[id]) {
            if (filpath && fs.existsSync(filpath)) fs.unlinkSync(filpath);
            discardPending();
            break;
          }
          if (!filpath) {
            discardPending();
            break;
          }
          prefetch();

          segmentSet.add(segment.uri);
          if (ffmpegObj == null) {
            let outPathMP4 = path.join(dir, id + '.mp4');
            let newid = id;
            while (fs.existsSync(outPathMP4)) {
              outPathMP4 = path.join(dir, newid + '.mp4');
              newid = newid + 1;
            }
            if (fs.existsSync(ffmpegPath)) {
              ffmpegInputStream = new FFmpegStreamReadable(null);
              ffmpegObj = new ffmpeg(ffmpegInputStream)
                .setFfmpegPath(ffmpegPath)
                .videoCodec('copy')
                .audioCodec('copy')
                .save(outPathMP4)
                .on('error', error => {
                  activeMerges.delete(id);
                  if (globalCond[id]) logger.error(error);
                })
                .on('end', function () {
                  activeMerges.delete(id);
                  if (!globalCond[id]) return;
                  video.videopath = outPathMP4;
                  video.status = '已完成';
                  mainWindow.webContents.send('task-notify-end', video);
                  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
                })
                .on('progress', logger.info);
              activeMerges.set(id, { command: ffmpegObj, input: ffmpegInputStream });
            } else {
              video.videopath = outPathMP4;
              video.status = '已完成，未发现本地FFMPEG，不进行合成。';
              mainWindow.webContents.send('task-notify-update', video);
            }
          }

          if (ffmpegInputStream) {
            ffmpegInputStream.push(fs.readFileSync(filpath));
            fs.unlinkSync(filpath);
          }
          count_downloaded += 1;
          video.segment_downloaded = count_downloaded;
          video.status = `直播中... [${count_downloaded}]`;
          mainWindow.webContents.send('task-notify-update', video);
        }
        if (globalCond[id]) {
          //使下次下载M3U8时间提前1秒钟。
          _videoDuration = Math.max(1000, _videoDuration - 1000);
          let _downloadTime = (new Date().getTime() - _startTime.getTime());
          if (_downloadTime < _videoDuration) {
            await sleep(_videoDuration - _downloadTime);
          }
        }
      }
      else {
        break;
      }
      parser = null;
    }
    catch (error) {
      logger.error(error.response ? error.response.body : error);
    }
  }
  if (ffmpegInputStream && globalCond[id]) {
    ffmpegInputStream.push(null);
  }

  if (count_downloaded <= 0 && globalCond[id]) {
    video.videopath = '';
    video.status = "已完成，下载失败"
    mainWindow.webContents.send('task-notify-end', video);
    return;
  }
}


function formatTime(duration) {
  let sec = Math.floor(duration % 60).toLocaleString();
  let min = Math.floor(duration / 60 % 60).toLocaleString();
  let hour = Math.floor(duration / 3600 % 60).toLocaleString();
  if (sec.length != 2) sec = '0' + sec;
  if (min.length != 2) min = '0' + min;
  if (hour.length != 2) hour = '0' + hour;
  return hour + ":" + min + ":" + sec;
}


function removeTaskDownloads(video, otherVideos) {
  const name = String(video.taskName || video.id).replace(/["“”，\.。\|\/\\ \*:;\?<>]/g, '');
  if (!video.dir || !name) throw new Error('Task directory is missing');
  const dir = path.resolve(video.dir);
  if (path.basename(dir) !== name) throw new Error('Task directory does not match task name');
  if (otherVideos.some(other => other.dir && path.resolve(other.dir) === dir)) {
    throw new Error('Task directory is shared with another task');
  }
  if (fs.existsSync(dir)) {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Task directory is a symbolic link');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const output = path.join(path.dirname(dir), `${name}.mp4`);
  if (fs.existsSync(output)) fs.rmSync(output, { force: true, maxRetries: 5, retryDelay: 100 });
}

ipcMain.on('delvideo', function (event, id) {
  configVideos.forEach(Element => {
    if (Element.id == id) {
      try {
        cancelTask(Element.id);
        removeTaskDownloads(Element, configVideos.filter(video => video.id != Element.id));
        logger.info(`event=task_delete task_id=${Element.id} files=deleted`);
        var nIdx = configVideos.indexOf(Element);
        if (nIdx > -1) {
          configVideos.splice(nIdx, 1);
          fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
        }
        event.sender.send("delvideo-reply", Element);
      } catch (error) {
        logger.error(error)
      }
    }
  });
});

function showDirInExploer(dir) {
  shell.openExternal(dir).catch((reason) => {
    logger.error(`openExternal Error:${dir} ${reason}`);

    let files = fs.readdirSync(dir);
    if (files && files.length > 0) {
      shell.showItemInFolder(path.join(dir, files[0]));
    }
    else {
      shell.showItemInFolder(dir);
    }
  });
}

ipcMain.on('opendir', function (event, arg) {
  showDirInExploer(arg)
});

ipcMain.on('playvideo', function (event, arg) {
  createPlayerWindow(arg);
});
ipcMain.on('StartOrStop', function (event, arg) {
  let id = Number.parseInt(arg);
  const video = configVideos.find(item => item.id == id);
  if (!video || video.completed) return;
  if (globalCond[id]) {
    logger.info(`event=download_stop task_id=${id}`);
    cancelTask(id);
    video.paused = true;
    video.status = '已暂停';
  } else {
    logger.info(`event=download_resume task_id=${id}`);
    video.paused = false;
    video.status = '正在恢复...';
    globalCond[id] = true;
    if (video.isLiving) startDownloadLive(video);
    else startDownload(video);
  }
  fs.writeFileSync(globalConfigVideoPath, JSON.stringify(configVideos));
  mainWindow && mainWindow.webContents.send('task-notify-update', video);
});

ipcMain.on('setting_isdelts', function (event, arg) {
  isdelts = arg;
});

ipcMain.on('get-config-dir', function (event, arg) {
  event.sender.send("get-config-dir-reply", {
    config_save_dir: globalConfigSaveVideoDir,
    config_ffmpeg: ffmpegPath,
    config_proxy: nconf.get('config_proxy'),
    config_segment_retry_count: getConfiguredSegmentRetryCount()
  });
})
ipcMain.on('set-config', function (event, data) {
  if (data.key == 'segment_retry_count') data.value = normalizeSegmentRetryCount(data.value);
  nconf.set(data.key, data.value);
  nconf.save();

  if (data.key == 'config_proxy') {
    const config_proxy = nconf.get('config_proxy');
    proxy_agent = config_proxy ? {
      http: new HttpProxyAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 256,
        maxFreeSockets: 256,
        scheduling: 'lifo',
        proxy: config_proxy
      }),
      https: new HttpsProxyAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 256,
        maxFreeSockets: 256,
        scheduling: 'lifo',
        proxy: config_proxy
      })
    } : direct_agent;
  }
})

ipcMain.on('open-config-dir', function (event, arg) {
  let SaveDir = globalConfigSaveVideoDir;
  logger.debug(`初始目录 ${SaveDir}`);
  dialog.showOpenDialog(mainWindow, {
    title: "请选择文件夹",
    defaultPath: SaveDir ? SaveDir : '',
    properties: ['openDirectory', 'createDirectory'],
  }).then(result => {
    if (!result.canceled && result.filePaths.length == 1) {
      logger.debug(`选择目录 ${result.filePaths}`);
      globalConfigSaveVideoDir = result.filePaths[0];
      nconf.set('SaveVideoDir', globalConfigSaveVideoDir);
      nconf.save();
      event.sender.send("get-config-dir-reply", { config_save_dir: globalConfigSaveVideoDir, config_ffmpeg: ffmpegPath });
    }
  }).catch(err => {
    logger.error(`showOpenDialog ${err}`)
  });
});

ipcMain.on('open-select-m3u8', function (event, arg) {
  dialog.showOpenDialog(mainWindow, {
    title: "请选择一个M3U8文件",
    properties: ['openFile'],
  }).then(result => {
    if (!result.canceled && result.filePaths.length == 1) {
      event.sender.send("open-select-m3u8-reply", `file:///${result.filePaths[0]}`);
    }
  }).catch(err => {
    logger.error(`showOpenDialog ${err}`)
  });
});

ipcMain.on('open-select-ts-dir', function (event, arg) {
  if (arg) {
    let files = [];
    try {
      files = fs.readdirSync(result.filePaths[0])
    } catch (error) {

    }
    if (files && files.length > 0) {
      let _files = files.filter((f) => {
        return f.endsWith('.ts') || f.endsWith('.TS')
      });
      if (_files.length) {
        event.sender.send("open-select-ts-select-reply", _files);
        return;
      }
    }
    return;
  }
  dialog.showOpenDialog(mainWindow, {
    title: "请选择欲合并的TS文件",
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频片段', extensions: ['ts'] }, { name: '所有文件', extensions: ['*'] }]
  }).then(result => {
    if (!result.canceled && result.filePaths.length >= 1) {
      if (result.filePaths.length == 1) {
        event.sender.send("open-select-ts-dir-reply", result.filePaths[0]);

        let files = [];
        try {
          files = fs.readdirSync(result.filePaths[0])
        } catch (error) {

        }
        if (files && files.length > 0) {
          let _files = files.filter((f) => {
            return f.endsWith('.ts') || f.endsWith('.TS')
          });
          if (_files && _files.length) {
            event.sender.send("open-select-ts-select-reply", _files);
            return;
          }
          else {
            event.sender.send("open-select-ts-select-reply", files);
            return;
          }
        }
      }
      let _files = result.filePaths.filter((f) => {
        return f.endsWith('.ts') || f.endsWith('.TS')
      });
      if (_files && _files.length) {
        event.sender.send("open-select-ts-select-reply", _files);
      }
      else {
        event.sender.send("open-select-ts-select-reply", result.filePaths);
      }
    }
  }).catch(err => {
    logger.error(`showOpenDialog ${err}`)
  });
});

ipcMain.on('start-merge-ts', async function (event, task) {
  if (!task) return;
  let name = task.name ? task.name : (new Date().getTime() + '');
  logger.info(`event=merge_start source=manual name=${JSON.stringify(name)} segments=${Array.isArray(task.ts_files) ? task.ts_files.length : 0}`);

  let dir = path.join(globalConfigSaveVideoDir, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  let outPathMP4 = path.join(dir, `${new Date().getTime()}.mp4`);

  if (fs.existsSync(ffmpegPath)) {
    mainWindow.webContents.send('start-merge-ts-status', { code: 0, progress: 1, status: '开始合并...' });
    const ffmpegInputStream = createSegmentStream(task.ts_files, (completed, total) => {
      let percent = Number.parseInt(completed * 100 / total);
      mainWindow.webContents.send('start-merge-ts-status', { code: 0, progress: percent, status: `合并中...[${percent}%]` });
    });

    let ffmpegObj = new ffmpeg(ffmpegInputStream)
      .setFfmpegPath(ffmpegPath)
      .videoCodec(task.mergeType == 'speed' ? 'copy' : 'libx264')
      .audioCodec(task.mergeType == 'speed' ? 'copy' : 'aac')
      .format('mp4')
      .save(outPathMP4)
      .on('error', (error) => {
        logger.error(`event=merge_failed source=manual message=${JSON.stringify(error.message)}`);
        logger.error(error)
        mainWindow.webContents.send('start-merge-ts-status', { code: -2, progress: 100, status: '合并出错|' + error });
      })
      .on('end', function () {
        logger.info(`event=merge_complete source=manual output=${JSON.stringify(outPathMP4)}`);
        mainWindow.webContents.send('start-merge-ts-status', { code: 1, progress: 100, status: 'success', dir: dir, path: outPathMP4 });
      })
      .on('progress', (info) => {
        logger.info(JSON.stringify(info));
        mainWindow.webContents.send('start-merge-ts-status', { code: 0, progress: -1, status: JSON.stringify(info) });
      });
  }
  else {
    mainWindow.webContents.send('start-merge-ts-status', { code: -1, progress: 100, status: '未检测到FFMPEG,不进行合并操作。' });
  }
});
