'use strict';
/**
 * Local Web Terminal — backend
 * Serves index.html and bridges a WebSocket to a real cmd.exe / powershell.exe.
 * Bound to 127.0.0.1 only. Run:  node server.js   (add --open to launch the browser)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const INDEX_PATH = path.join(__dirname, 'index.html');
const MAX_CLIENTS = 8;
const MAX_LINE = 8000;

if (process.platform !== 'win32') {
  console.error('This terminal bridges to cmd.exe / powershell.exe, so it only runs on Windows.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Security: token + Host/Origin checks (blocks hijacking from other  */
/* websites and DNS-rebinding attacks against the local port).        */
/* ------------------------------------------------------------------ */
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const hostOk = (h) => typeof h === 'string' && ALLOWED_HOSTS.has(h.toLowerCase());
const originOk = (o) => typeof o === 'string' && ALLOWED_ORIGINS.has(o.toLowerCase());
const tokenOk = (t) => {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  `connect-src ws://127.0.0.1:${PORT} ws://localhost:${PORT}`,
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/* ------------------------------------------------------------------ */
/* Aliases: Linux + Arabic -> native commands                          */
/* (doskey macros do NOT work when stdin is a pipe, so we translate    */
/*  the line on the server before it reaches the shell.)               */
/* ------------------------------------------------------------------ */
const normalizeAr = (s) =>
  s
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // diacritics + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');

// Arabic word -> canonical (Linux-style) command name
const AR = {
  'ملفات': 'ls',
  'مسح': 'clear',
  'ادخل': 'cd',
  'شجرة': 'tree',
  'اقرا': 'cat',
  'انسخ': 'cp',
  'انقل': 'mv',
  'احذف': 'rm',
  'انشئ': 'mkdir',
  'مكاني': 'pwd',
  'خروج': 'exit',
};

const tokenize = (rest) => rest.match(/"[^"]*"|\S+/g) || [];

function splitFlags(tokens, allowed) {
  const flags = new Set();
  const args = [];
  for (const t of tokens) {
    if (/^--[A-Za-z-]+$/.test(t)) continue; // drop long GNU flags
    if (/^-[A-Za-z0-9]+$/.test(t) && (!allowed || [...t.slice(1)].every((c) => allowed.includes(c)))) {
      for (const c of t.slice(1)) flags.add(c);
    } else {
      args.push(t);
    }
  }
  return { flags, args };
}

// ./src/file.txt -> .\src\file.txt   (leave "/switch" style tokens and URLs alone)
const winPath = (a) => {
  if (/^\/[^\/\\]*$/.test(a) || a.includes('://')) return a;
  return a.replace(/\//g, '\\');
};

const CMD_HANDLERS = {
  ls: (t, forceAll) => {
    const { flags, args } = splitFlags(t);
    if (forceAll) flags.add('a');
    const o = [];
    if (flags.has('a')) o.push('/a');
    if (flags.has('R')) o.push('/s');
    if (flags.has('t')) o.push('/o-d');
    else if (flags.has('S')) o.push('/o-s');
    if (flags.has('1')) o.push('/b');
    return ['dir', ...o, ...args.map(winPath)];
  },
  ll: (t) => CMD_HANDLERS.ls(t, true),
  pwd: () => ['cd'],
  cat: (t) => ['type', ...splitFlags(t).args.map(winPath)],
  clear: () => ['cls'],
  rm: (t) => {
    const { flags, args } = splitFlags(t);
    const targets = args.map(winPath);
    if (flags.has('r') || flags.has('R')) return ['rmdir', '/s', '/q', ...targets];
    return ['del', '/q', ...(flags.has('f') ? ['/f'] : []), ...targets];
  },
  cp: (t) => {
    const { flags, args } = splitFlags(t);
    const targets = args.map(winPath);
    if (flags.has('r') || flags.has('R')) return ['xcopy', '/e', '/i', '/y', ...targets];
    return ['copy', '/y', ...targets];
  },
  mv: (t) => ['move', '/y', ...splitFlags(t).args.map(winPath)],
  mkdir: (t) => ['mkdir', ...splitFlags(t).args.map(winPath)],
  grep: (t) => {
    const { flags, args } = splitFlags(t);
    const o = [];
    if (flags.has('i')) o.push('/i');
    if (flags.has('n')) o.push('/n');
    if (flags.has('v')) o.push('/v');
    if (flags.has('r') || flags.has('R')) o.push('/s');
    if (args.length) {
      const pat = args[0];
      const bare = pat.replace(/^"|"$/g, '');
      // findstr treats spaces as OR; use a literal match for multi-word patterns
      args[0] = /\s/.test(bare) && !flags.has('E') ? `/c:"${bare}"` : pat;
    }
    return ['findstr', ...o, ...args.map((a, i) => (i === 0 ? a : winPath(a)))];
  },
  which: (t) => ['where', ...splitFlags(t).args],
  touch: (t) => {
    const files = splitFlags(t).args.map(winPath);
    return files.length ? [files.map((f) => `type nul >> ${f}`).join(' & ')] : ['echo touch: missing file operand'];
  },
  man: (t) => ['help', ...splitFlags(t).args],
  cd: (t) => ['cd', ...t],
  tree: (t) => ['tree', ...t],
  exit: () => ['exit'],
};

const PS_UNIX_FLAGS = 'alhRtSrdf1';
const PS_HANDLERS = {
  ls: (t, forceAll) => {
    const { flags, args } = splitFlags(t, PS_UNIX_FLAGS);
    if (forceAll) flags.add('a');
    const o = [];
    if (flags.has('a')) o.push('-Force');
    if (flags.has('R')) o.push('-Recurse');
    return ['Get-ChildItem', ...o, ...args];
  },
  ll: (t) => PS_HANDLERS.ls(t, true),
  rm: (t) => {
    const { flags, args } = splitFlags(t, PS_UNIX_FLAGS);
    const o = [];
    if (flags.has('r') || flags.has('R')) o.push('-Recurse');
    if (flags.has('f')) o.push('-Force');
    return ['Remove-Item', ...o, ...args];
  },
  cp: (t) => {
    const { flags, args } = splitFlags(t, PS_UNIX_FLAGS);
    return ['Copy-Item', ...(flags.has('r') || flags.has('R') ? ['-Recurse'] : []), ...args];
  },
  clear: () => ['cls'],
};
// words that are already native in PowerShell (cat, pwd, mv, cd, tree, mkdir, exit, grep…)
const PS_PASS = new Set(['cat', 'pwd', 'mv', 'cd', 'tree', 'mkdir', 'exit', 'grep', 'which', 'touch', 'man']);

function expandSegment(seg, kind) {
  const m = /^(\s*)(\S+)([\s\S]*)$/.exec(seg);
  if (!m) return seg;
  const [, lead, word, rest] = m;
  const canon = AR[normalizeAr(word)] || word.toLowerCase();
  const tokens = tokenize(rest);
  if (kind === 'cmd') {
    const h = CMD_HANDLERS[canon];
    // keep native words (dir, type, copy…) untouched unless they came from Arabic
    if (!h || (canon === word.toLowerCase() && ['cd', 'tree', 'exit'].includes(canon) && !AR[normalizeAr(word)])) return seg;
    return lead + h(tokens).join(' ');
  }
  const h = PS_HANDLERS[canon];
  if (h) return lead + h(tokens).join(' ');
  if (AR[normalizeAr(word)]) return lead + [canon, ...tokens].join(' ');
  if (PS_PASS.has(canon)) return seg;
  return seg;
}

function expandAliases(line, kind) {
  // translate the first word of each pipeline segment (…| grep foo)
  return line
    .split(/(?<!\|)\|(?!\|)/)
    .map((seg) => expandSegment(seg, kind))
    .join('|');
}

/* ------------------------------------------------------------------ */
/* Prompt marker. Both shells are configured to print:                 */
/*   ESC ] cwd:<path> ESC \                                            */
/* which we strip from the output and turn into a {type:'prompt'}.     */
/* ------------------------------------------------------------------ */
const MARK = '\x1b]cwd:';

function scan(st, chunk, onText, onCwd) {
  let s = st.carry + chunk;
  st.carry = '';
  while (s.length) {
    const i = s.indexOf(MARK);
    if (i === -1) {
      const k = s.lastIndexOf('\x1b');
      if (k !== -1 && MARK.startsWith(s.slice(k))) {
        st.carry = s.slice(k);
        s = s.slice(0, k);
      }
      if (s) onText(s);
      return;
    }
    if (i > 0) onText(s.slice(0, i));
    const j = s.indexOf('\x1b\\', i + MARK.length);
    if (j === -1) {
      if (s.length - i > 4096) onText(s.slice(i));
      else st.carry = s.slice(i);
      return;
    }
    onCwd(s.slice(i + MARK.length, j));
    s = s.slice(j + 2);
  }
}

/* ------------------------------------------------------------------ */
/* Process helpers                                                      */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Tab completion: commands (aliases, builtins, PATH) + file paths     */
/* ------------------------------------------------------------------ */
const LINUX_NAMES = ['ls', 'll', 'pwd', 'cat', 'clear', 'rm', 'cp', 'mv', 'mkdir', 'grep', 'which', 'touch', 'man'];
const CMD_BUILTINS = [
  'assoc', 'call', 'cd', 'chdir', 'cls', 'copy', 'date', 'del', 'dir', 'echo', 'erase', 'exit', 'findstr', 'for',
  'goto', 'help', 'if', 'md', 'mkdir', 'mklink', 'more', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd',
  'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'start', 'time', 'title', 'tree', 'type', 'ver', 'vol', 'where', 'xcopy',
];
const PS_BUILTINS = [
  'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content', 'Get-Location', 'Set-Location', 'Copy-Item', 'Move-Item',
  'Remove-Item', 'New-Item', 'Rename-Item', 'Get-Item', 'Test-Path', 'Get-Process', 'Stop-Process', 'Start-Process',
  'Get-Service', 'Get-Command', 'Get-Help', 'Get-Date', 'Select-String', 'Select-Object', 'Where-Object', 'ForEach-Object',
  'Sort-Object', 'Measure-Object', 'Format-Table', 'Format-List', 'Out-File', 'Out-String', 'Write-Host', 'Write-Output',
  'Clear-Host', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Invoke-Expression', 'Get-Alias', 'Get-Member', 'Compare-Object',
  'Expand-Archive', 'Compress-Archive', 'Test-Connection', 'Resolve-DnsName',
  'cd', 'dir', 'type', 'copy', 'move', 'del', 'echo', 'cls', 'exit', 'tree', 'rmdir', 'ren', 'sl', 'gci', 'gc', 'gcm', 'ps', 'kill', 'sls', 'iwr', 'irm',
];
const DIRS_ONLY = new Set(['cd', 'chdir', 'pushd', 'rmdir', 'rd', 'sl', 'set-location', 'push-location', 'ادخل']);
const NEEDS_QUOTE = /[\s&()^%!,;=@$'`\[\]{}+]/;

let pathCache = { t: 0, names: new Set() };
async function pathCommands() {
  if (Date.now() - pathCache.t < 30000) return pathCache.names;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const names = new Set();
  await Promise.all(dirs.map(async (d) => {
    try {
      for (const f of await fs.promises.readdir(d)) {
        const ext = path.extname(f).toLowerCase();
        if (ext && exts.includes(ext)) names.add(f.slice(0, -ext.length));
      }
    } catch (_) { /* unreadable PATH entry */ }
  }));
  pathCache = { t: Date.now(), names };
  return names;
}

async function completeLine(kind, cwd, line, cursor) {
  const text = line.slice(0, cursor);

  // find the token under the cursor (quote-aware) and where its pipeline segment starts
  let inQ = false, tokStart = 0, segStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (inQ) continue;
    if (/\s/.test(ch)) tokStart = i + 1;
    else if (ch === '|' || ch === '&' || ch === ';') { tokStart = i + 1; segStart = i + 1; }
  }
  const token = text.slice(tokStart);
  const segment = text.slice(segStart, tokStart).trim();
  const isCommand = segment === '';
  const first = normalizeAr(segment.split(/\s+/)[0] || '').toLowerCase();
  const quoted = token.startsWith('"');
  const raw = (quoted ? token.slice(1) : token).replace(/"$/, '');
  const none = { start: tokStart, items: [] };

  // flags like -la, /d, /s are not paths
  if (!quoted && (raw.startsWith('-') || (kind === 'cmd' && /^\/[A-Za-z?]*$/.test(raw)))) return none;

  // 1) command name
  if (isCommand && !quoted && raw && !/[\\/]/.test(raw)) {
    const low = raw.toLowerCase();
    const nr = normalizeAr(raw);
    const pool = new Map();
    const add = (n) => { const k = n.toLowerCase(); if (!pool.has(k)) pool.set(k, n); };
    LINUX_NAMES.forEach(add);
    (kind === 'cmd' ? CMD_BUILTINS : PS_BUILTINS).forEach(add);
    Object.keys(AR).forEach(add);
    (await pathCommands()).forEach(add);
    const items = [...pool.values()]
      .filter((n) => n.toLowerCase().startsWith(low) || normalizeAr(n).startsWith(nr))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 150)
      .map((n) => ({ text: n, label: n, dir: false }));
    return { start: tokStart, items };
  }

  // 2) file / folder path
  const m = /^([\s\S]*[\\/])?([^\\/]*)$/.exec(raw);
  const dirPart = m[1] || '';
  const namePart = m[2];
  let base;
  if (!dirPart) base = cwd || os.homedir();
  else if (/^~[\\/]/.test(dirPart)) base = path.join(os.homedir(), dirPart.slice(2));
  else base = path.resolve(cwd || os.homedir(), dirPart);

  let entries;
  try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch (_) { return none; }

  const dirsOnly = DIRS_ONLY.has(first);
  const lowName = namePart.toLowerCase();
  const found = [];
  for (const e of entries) {
    if (!e.name.toLowerCase().startsWith(lowName)) continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = (await fs.promises.stat(path.join(base, e.name))).isDirectory(); } catch (_) { /* broken link */ }
    }
    if (dirsOnly && !isDir) continue;
    found.push({ name: e.name, isDir });
  }
  found.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const sep = dirPart.includes('/') && !dirPart.includes('\\') ? '/' : '\\';
  const needQ = quoted || found.some((f) => NEEDS_QUOTE.test(dirPart + f.name));
  const items = found.slice(0, 200).map((f) => {
    const label = f.name + (f.isDir ? sep : '');
    const full = dirPart + label;
    // folders keep the quote open so you can keep tabbing deeper
    return { text: needQ ? '"' + full + (f.isDir ? '' : '"') : full, label, dir: f.isDir };
  });
  return { start: tokStart, items };
}

const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CMD_EXE = process.env.ComSpec || path.join(SYS32, 'cmd.exe');
const PS_EXE = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const PS_INIT = [
  "try { [Console]::InputEncoding = [Console]::OutputEncoding = (New-Object System.Text.UTF8Encoding $false) } catch {}",
  "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$ProgressPreference = 'SilentlyContinue'",
  "function __p { Write-Host -NoNewline (([string][char]27) + ']cwd:' + (Get-Location).Path + ([string][char]27) + '\\') }",
  "Set-Alias grep Select-String",
  "Set-Alias which Get-Command",
  "function ll { Get-ChildItem -Force @args }",
  "function touch { foreach ($f in $args) { if (Test-Path -LiteralPath $f) { (Get-Item -LiteralPath $f).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path $f | Out-Null } } }",
  '__p',
].join('; ');

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  } catch (_) { /* already gone */ }
}

// Ctrl+C equivalent: kill the shell's child processes (not the shell, nor its console host).
function killChildren(pid) {
  return new Promise((resolve) => {
    const script =
      "$n=0; Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + Number(pid) + "' | " +
      "Where-Object { $_.Name -notin 'conhost.exe','OpenConsole.exe' } | " +
      "ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $n++ }; Write-Output $n";
    let out = '';
    let done = false;
    const finish = (n) => { if (!done) { done = true; resolve(n); } };
    const p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => finish(0));
    p.on('close', () => finish(parseInt(out.trim(), 10) || 0));
    setTimeout(() => { try { p.kill(); } catch (_) {} finish(0); }, 8000);
  });
}

/* ------------------------------------------------------------------ */
/* One session per WebSocket connection                                */
/* ------------------------------------------------------------------ */
const sessions = new Set();

function createSession(ws) {
  let child = null;
  let kind = 'cmd';
  let gen = 0;
  let busy = false;
  let cwdNow = '';
  let queue = [];
  let timer = null;

  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  const flush = () => {
    timer = null;
    const q = queue;
    queue = [];
    for (const m of q) send(m);
  };
  const enqueue = (msg) => {
    const last = queue[queue.length - 1];
    if (msg.type === 'output' && last && last.type === 'output' && last.stream === msg.stream) last.data += msg.data;
    else queue.push(msg);
    if (!timer) timer = setTimeout(flush, 8);
  };

  function stop() {
    gen++;
    if (child) {
      const c = child;
      child = null;
      try { c.stdin.destroy(); } catch (_) {}
      killTree(c.pid);
    }
    busy = false;
  }

  function start(want) {
    stop();
    kind = want === 'powershell' ? 'powershell' : 'cmd';
    const myGen = gen;
    busy = true;

    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
    const base = { cwd: os.homedir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };

    let c;
    try {
      if (kind === 'cmd') {
        // /Q echo off, /K keep alive. Prompt = invisible marker carrying the cwd.
        c = spawn(CMD_EXE, ['/Q', '/K', 'chcp 65001 >nul&prompt $E]cwd:$P$E\\'], { ...base, windowsVerbatimArguments: true });
      } else {
        c = spawn(PS_EXE, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'], base);
      }
    } catch (err) {
      send({ type: 'status', state: 'error', shell: kind, message: String(err.message || err) });
      return;
    }
    child = c;

    const dOut = new StringDecoder('utf8');
    const dErr = new StringDecoder('utf8');
    const st = { carry: '' };

    c.stdout.on('data', (buf) => {
      if (myGen !== gen) return;
      const text = dOut.write(buf);
      if (!text) return;
      scan(
        st,
        text,
        (t) => enqueue({ type: 'output', stream: 'out', data: t }),
        (cwd) => { busy = false; cwdNow = cwd; enqueue({ type: 'prompt', cwd }); }
      );
    });
    c.stderr.on('data', (buf) => {
      if (myGen !== gen) return;
      const text = dErr.write(buf);
      if (text) enqueue({ type: 'output', stream: 'err', data: text });
    });
    c.stdin.on('error', () => {});
    c.on('error', (err) => {
      if (myGen !== gen) return;
      enqueue({ type: 'status', state: 'error', shell: kind, message: String(err.message || err) });
    });
    c.on('exit', (code) => {
      if (myGen !== gen) return;
      child = null;
      busy = false;
      enqueue({ type: 'status', state: 'exited', shell: kind, code });
    });

    if (kind === 'powershell') c.stdin.write(PS_INIT + '\n', 'utf8');
    send({ type: 'status', state: 'started', shell: kind });
  }

  function writeToShell(line) {
    if (!child || !child.stdin.writable) return;
    child.stdin.write(line + '\r\n', 'utf8');
  }

  function handleInput(raw) {
    if (!child) return;
    const line = String(raw).replace(/[\r\n\0]+/g, ' ').slice(0, MAX_LINE);

    // A program is running and waiting on stdin (input(), Console.ReadLine(), Read-Host…): pass through untouched.
    if (busy) { writeToShell(line); return; }

    const expanded = expandAliases(line, kind);

    if (/^\s*(cls|clear|clear-host)\s*$/i.test(expanded)) {
      enqueue({ type: 'clear' });
      writeToShell(kind === 'powershell' ? '__p' : ''); // just get a fresh prompt back
      busy = true;
      return;
    }
    if (!expanded.trim()) {
      writeToShell(kind === 'powershell' ? '__p' : '');
      busy = true;
      return;
    }

    busy = true;
    if (kind === 'powershell') {
      const b64 = Buffer.from(expanded, 'utf8').toString('base64');
      writeToShell(
        `. { try { Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))) } ` +
        `catch { [Console]::Error.WriteLine(($_ | Out-String).TrimEnd()) } }; __p`
      );
    } else {
      writeToShell(expanded);
    }
  }

  async function interrupt() {
    if (!child || !busy) return;
    const n = await killChildren(child.pid);
    if (n === 0) {
      send({ type: 'info', message: 'No child process to interrupt (in-process command?). Use Reconnect to restart the shell.' });
    }
  }

  async function complete(msg) {
    const id = msg.id;
    const respond = (items, start) => send({ type: 'completion', id, start, items });
    if (!child || busy || typeof msg.line !== 'string') return respond([], 0);
    const line = msg.line.slice(0, MAX_LINE);
    const cursor = Math.max(0, Math.min(Number(msg.cursor) | 0, line.length));
    try {
      const r = await completeLine(kind, cwdNow, line, cursor);
      respond(r.items, r.start);
    } catch (_) {
      respond([], 0);
    }
  }

  const session = {
    start,
    complete,
    handleInput,
    interrupt,
    dispose() {
      stop();
      if (timer) clearTimeout(timer);
      sessions.delete(session);
    },
    killNow() { if (child) killTree(child.pid); },
  };
  sessions.add(session);
  return session;
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket                                                    */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  if (!hostOk(req.headers.host)) { res.writeHead(403); return res.end('Forbidden'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const p = (req.url || '/').split('?')[0];

  if (p === '/' || p === '/index.html') {
    fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('index.html not found next to server.js'); }
      const body = html.replace('__SESSION_TOKEN__', TOKEN);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    return;
  }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p !== '/ws' || !hostOk(req.headers.host) || !originOk(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  let token = null;
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch (_) {}
  if (!tokenOk(token)) { ws.close(1008, 'bad token'); return; }
  if (sessions.size >= MAX_CLIENTS) { ws.close(1013, 'too many sessions'); return; }

  const session = createSession(ws);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'start': session.start(msg.shell); break;
      case 'input': session.handleInput(msg.data); break;
      case 'interrupt': session.interrupt(); break;
      case 'complete': session.complete(msg); break;
      default: break;
    }
  });
  ws.on('close', () => session.dispose());
  ws.on('error', () => session.dispose());
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try:  set PORT=8081 && node server.js`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Web Terminal running at ${url}  (bound to ${HOST} only)`);
  console.log('Press Ctrl+C here to stop the server.');
  if (process.argv.includes('--open')) {
    spawn('cmd.exe', ['/c', 'start', 'WebTerminal', url], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
  }
});

function shutdown() {
  for (const s of sessions) s.killNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { for (const s of sessions) s.killNow(); });
