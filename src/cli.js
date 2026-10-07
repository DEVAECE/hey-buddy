// Command-line AI tools that sign in with a normal account (no API key):
//   codex  - OpenAI Codex CLI   (ChatGPT account)
//   claude - Claude Code        (Claude account)
//   gemini - Gemini CLI         (Google account)
// Each runs non-interactively, read-only, in an empty scratch folder, and only returns text.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

const TOOLS = {
  codex: { pkg: '@openai/codex', script: ['@openai', 'codex', 'bin', 'codex.js'], account: 'ChatGPT', signIn: 'codex login' },
  claude: { pkg: '@anthropic-ai/claude-code', exe: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], account: 'Claude', signIn: 'claude auth login' },
  gemini: { pkg: '@google/gemini-cli', script: ['@google', 'gemini-cli', 'bundle', 'gemini.js'], account: 'Google', signIn: 'gemini' },
};

const npmDir = () => (process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null);

// A console node.exe for the Node-based tools. Electron's own exe is a windowed program: anything
// it starts gets a *visible* console (a terminal window flashing on every message), whereas a
// console node.exe started with windowsHide gets a hidden console that the tools' own child
// processes (e.g. codex.exe) inherit.
// Only a found node.exe is remembered, so installing Node.js while Buddy runs is picked up.
let nodeExe = null;
function findNode() {
  if (nodeExe) return nodeExe;
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), npmDir()];
  nodeExe = dirs.filter(Boolean).map((d) => path.join(d.replace(/"/g, ''), 'node.exe')).find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
  return nodeExe;
}

// Find how to start a tool without a shell (so arguments need no quoting).
// Node scripts run on the system node.exe (see findNode), else Electron's own Node.
function resolveCli(name) {
  const t = TOOLS[name];
  const dir = npmDir();
  if (isWin && dir) {
    if (t.exe) {
      const exe = path.join(dir, 'node_modules', ...t.exe);
      if (fs.existsSync(exe)) return { cmd: exe, pre: [], env: {} };
    }
    if (t.script) {
      const script = path.join(dir, 'node_modules', ...t.script);
      if (fs.existsSync(script)) {
        const node = findNode();
        if (node) return { cmd: node, pre: [script], env: {} };
        return process.versions.electron
          ? { cmd: process.execPath, pre: [script], env: { ELECTRON_RUN_AS_NODE: '1' } } // last resort (may flash a window)
          : { cmd: process.execPath, pre: [script], env: {} };
      }
    }
    return null;
  }
  return { cmd: name, pre: [], env: {} }; // elsewhere: rely on PATH
}

const isInstalled = (name) => !!resolveCli(name);

/** Run a tool; resolves {code, stdout, stderr, timedOut, notFound}. */
function runCli(name, args, { input = '', cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const r = resolveCli(name);
    if (!r) { resolve({ code: null, stdout: '', stderr: '', notFound: true }); return; }
    const dir = cwd || os.tmpdir();
    fs.mkdirSync(dir, { recursive: true });
    let stdout = ''; let stderr = ''; let timedOut = false; let done = false;
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    let child;
    try {
      child = spawn(r.cmd, [...r.pre, ...args], { cwd: dir, windowsHide: true, env: { ...process.env, ...r.env } });
    } catch (err) { finish({ code: null, stdout, stderr: String(err.message), notFound: err.code === 'ENOENT' }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    child.on('error', (err) => finish({ code: null, stdout, stderr: `${stderr}\n${err.message}`, notFound: err.code === 'ENOENT' }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

// Turn a failed run into an error with a friendly, actionable message.
function cliError(name, { code, stdout = '', stderr = '', timedOut, notFound } = {}) {
  const t = TOOLS[name];
  const text = `${stderr}\n${stdout}`;
  const e = new Error(`${name} ${timedOut ? 'timeout' : notFound ? 'not installed' : `exit ${code}`}`);
  e.detail = text.slice(-2000);
  const lastLine = (text.trim().split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /error|fail|"message"/i.test(l) && !/^at /.test(l) && !/\.(js|ts):\d+/.test(l)).pop() || '').slice(0, 200);
  if (notFound) e.friendly = `The ${t.account} connection needs its sign-in tool installed. Open Settings → AI connections and click Install.`;
  else if (name === 'gemini' && /IneligibleOrProjectId|GOOGLE_CLOUD_PROJECT|ineligible/i.test(text)) {
    e.friendly = 'Your Google account is a work (Google Workspace) account, which the free Gemini sign-in only supports with a Google Cloud project. Sign in with a personal Gmail account instead, or add a Gemini API key connection.';
  } else if (/not logged in|log ?in required|codex login|auth login|unauthori[sz]ed|\b401\b|refresh token|sign in again|set an auth method|loggedin":\s*false|invalid api key|oauth/i.test(text)) {
    e.friendly = `I'm not signed in to your ${t.account} account. Open Settings → AI connections and click Sign in.`;
  } else if (/usage limit|rate limit|\b429\b|quota|resource.?exhausted|try again (later|in)|too many requests/i.test(text)) {
    e.friendly = `Your ${t.account} plan's usage limit is reached for now. Try again later. ${lastLine}`.trim();
  } else if (timedOut) e.friendly = `${t.account} took too long to answer. Try again in a moment.`;
  else if (/error sending request|connection|network|dns|enotfound|econnreset|timed out|fetch failed/i.test(text)) {
    e.friendly = `I can't reach ${t.account} right now. Check your internet connection. Your tasks and reminders still work offline.`;
  } else e.friendly = `${t.account} couldn't answer. ${lastLine || `It exited with code ${code}.`}`.trim();
  return e;
}

// ---------- Claude Code ----------
const CLAUDE_SYSTEM = 'You are Buddy, a task-tracking assistant inside a desktop app. Answer only from the information in the prompt. You have no tools; never ask to run commands or read files.';

async function runClaude({ prompt, schema, model, workDir, timeoutMs }) {
  const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '',
    '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', CLAUDE_SYSTEM, '--model', model || 'sonnet'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const r = await runCli('claude', args, { input: prompt, cwd: workDir, timeoutMs });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (_) {}
  if (r.code !== 0 || !j || j.is_error || j.subtype !== 'success') {
    throw cliError('claude', { ...r, stderr: `${r.stderr}\n${j ? JSON.stringify({ result: j.result, subtype: j.subtype }) : ''}` });
  }
  if (schema && j.structured_output) return JSON.stringify(j.structured_output);
  return String(j.result || '').trim();
}

// ---------- Gemini CLI ----------
// No schema support: the prompt itself asks for the JSON shape, and Buddy parses leniently.
async function runGemini({ prompt, model, workDir, timeoutMs }) {
  const args = ['-p', 'Follow the instructions above.', '-o', 'json', '--approval-mode', 'plan', '--skip-trust'];
  if (model) args.push('-m', model);
  const r = await runCli('gemini', args, { input: prompt, cwd: workDir, timeoutMs });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (_) {}
  if (r.code !== 0 || !j || j.error || typeof j.response !== 'string') {
    throw cliError('gemini', { ...r, stderr: `${r.stderr}\n${j && j.error ? JSON.stringify(j.error) : ''}` });
  }
  return j.response.trim();
}

// ---------- status, sign-in, install ----------
async function signInStatus(name) {
  if (!isInstalled(name)) return { state: 'missing', text: 'Not installed' };
  if (name === 'codex') {
    const r = await runCli('codex', ['login', 'status'], { timeoutMs: 20000 });
    return /logged in/i.test(r.stdout + r.stderr) && !/not logged in/i.test(r.stdout + r.stderr)
      ? { state: 'ok', text: 'Signed in' } : { state: 'signin', text: 'Not signed in' };
  }
  if (name === 'claude') {
    const r = await runCli('claude', ['auth', 'status'], { timeoutMs: 20000 });
    try { const j = JSON.parse(r.stdout); return j.loggedIn ? { state: 'ok', text: 'Signed in' } : { state: 'signin', text: 'Not signed in' }; } catch (_) {}
    return { state: 'signin', text: 'Not signed in' };
  }
  return { state: 'unknown', text: 'Installed. Click Test to check sign-in' }; // gemini has no status command
}

// The sign-in (or install + sign-in) script, with instructions. Uses the tools' normal npm
// commands (interactive sign-in needs a real console).
// The PATH Buddy inherited is frozen at the moment Buddy started, so a Node.js installed since then
// isn't on it. Reload the current Machine + User PATH from Windows, and add Node's usual folders too.
const FRESH_PATH = [
  'set "PATH=%PATH%;%ProgramFiles%\\nodejs;%APPDATA%\\npm"',
  // (No quotes around the program: for /f strips a leading quote and breaks the command.)
  'for /f "usebackq delims=" %%P in (`%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\',\'User\')"`) do set "PATH=%%P;%ProgramFiles%\\nodejs;%APPDATA%\\npm"',
];

function signInScript(name, { install = false } = {}) {
  const t = TOOLS[name];
  const hint = name === 'gemini'
    ? ['Choose "Sign in with Google" and finish in your browser.', 'When Gemini is ready, type /quit to close it, then click Test in Buddy.']
    : [`Sign in to your ${t.account} account in the browser window that opens.`, 'When it says you are signed in, close this window and click Test in Buddy.'];
  const lines = ['@echo off', `title Buddy - connect your ${t.account} account`, ...FRESH_PATH, 'echo.'];
  if (install || !isInstalled(name)) {
    // The sign-in tools are installed with npm, which comes with Node.js. Jump to a label rather
    // than using an if ( ... ) block: a ")" in any echoed text would end such a block early.
    lines.push(
      'where npm >nul 2>nul',
      'if not errorlevel 1 goto :have_node',
      `echo Connecting your ${t.account} account needs Node.js, a free one-time install.`,
      'echo Opening nodejs.org: install the LTS version, then click "Sign in" in Buddy again.',
      'echo Or use an API key connection instead, which needs no install.',
      'start "" https://nodejs.org/',
      'goto :eof',
      ':have_node',
      `echo Installing the ${t.account} sign-in tool, one time only...`, `call npm install -g ${t.pkg}`, 'echo.',
    );
  }
  lines.push(...hint.map((h) => `echo ${h}`), 'echo.', `call ${t.signIn}`);
  return lines.join('\r\n');
}

// Open a console window that runs the sign-in (or install + sign-in), with instructions.
function openSignInWindow(name, opts = {}) {
  const file = path.join(os.tmpdir(), `buddy-signin-${name}-${crypto.randomBytes(3).toString('hex')}.cmd`);
  fs.writeFileSync(file, signInScript(name, opts), 'utf8');
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `"${file}"`],
    { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
  child.unref();
  return file;
}

module.exports = { TOOLS, resolveCli, isInstalled, runCli, cliError, runClaude, runGemini, signInStatus, openSignInWindow, signInScript };
