const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let item;
let file;
let refreshing = false;
let refreshError = null;

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Claude account folder used by this VS Code window. Order:
// 1. usageMeter.claudeConfigDir
// 2. CLAUDE_CONFIG_DIR in claudeCode.environmentVariables (Claude Code extension)
// 3. CLAUDE_CONFIG_DIR in the environment VS Code was launched with
// 4. none (default Claude Code location)
function claudeConfigDir() {
  const own = vscode.workspace.getConfiguration('usageMeter').get('claudeConfigDir');
  if (own) return expandHome(own);
  const vars = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables') || [];
  const fromClaudeCode = vars.find((v) => v?.name === 'CLAUDE_CONFIG_DIR')?.value;
  if (fromClaudeCode) return expandHome(fromClaudeCode);
  if (process.env.CLAUDE_CONFIG_DIR) return expandHome(process.env.CLAUDE_CONFIG_DIR);
  return null;
}

// Claude Code caches the /usage numbers in .claude.json: inside the config dir
// when CLAUDE_CONFIG_DIR is set, else in the home folder.
function connect() {
  if (file) fs.unwatchFile(file);
  const dir = claudeConfigDir();
  file = dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  fs.watchFile(file, { interval: 2000 }, render);
  render();
}

// Claude binary: usageMeter.claudePath, else the one bundled with the
// Claude Code VS Code extension, else `claude` from PATH.
function claudeBinary() {
  const own = vscode.workspace.getConfiguration('usageMeter').get('claudePath');
  if (own) return expandHome(own);
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bin = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(bin)) return bin;
  }
  return 'claude';
}

// Runs `/usage` headless, like opening Account & usage. It makes no model call
// (0 tokens) and skips user hooks, plugins and MCP servers. Claude Code then
// rewrites the cache in .claude.json, which the file watcher picks up.
function refresh() {
  if (refreshing) return;
  refreshing = true;
  const dir = claudeConfigDir();
  const env = dir ? { ...process.env, CLAUDE_CONFIG_DIR: dir } : process.env;
  const args = ['-p', '/usage', '--no-session-persistence', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config'];
  execFile(claudeBinary(), args, { cwd: os.homedir(), env, timeout: 30 * 1000 }, (err) => {
    refreshing = false;
    refreshError = err ? err.message.split('\n')[0] : null;
    render();
  });
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Claude Usage Meter';
  item.command = 'usageMeter.setLimit';

  // Re-render every minute so the reset countdown stays current.
  const timer = setInterval(render, 60 * 1000);
  let refreshTimer;
  const scheduleRefresh = () => {
    clearInterval(refreshTimer);
    const seconds = vscode.workspace.getConfiguration('usageMeter').get('refreshSeconds', 120);
    if (seconds > 0) {
      refreshTimer = setInterval(refresh, Math.max(seconds, 60) * 1000);
      refresh();
    }
  };

  context.subscriptions.push(
    item,
    { dispose: () => { fs.unwatchFile(file); clearInterval(timer); clearInterval(refreshTimer); } },
    vscode.commands.registerCommand('usageMeter.refresh', refresh),
    vscode.commands.registerCommand('usageMeter.setLimit', setLimit),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('usageMeter.claudeConfigDir') || e.affectsConfiguration('claudeCode.environmentVariables')) {
        connect();
        refresh();
      } else if (e.affectsConfiguration('usageMeter.refreshSeconds')) scheduleRefresh();
      else if (e.affectsConfiguration('usageMeter')) render();
    })
  );

  connect();
  scheduleRefresh();
}

function readUsage() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).cachedUsageUtilization ?? null;
  } catch {
    return null;
  }
}

function timeLeft(ms) {
  const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

// Hue 120 (green) at 0% of the limit down to 0 (red) at the limit.
function gradient(ratio) {
  const h = 120 * (1 - ratio);
  const s = 0.75;
  const l = 0.55;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function render() {
  const limit = vscode.workspace.getConfiguration('usageMeter').get('limitPercent', 90);
  const usage = readUsage();
  const session = usage?.utilization?.five_hour;
  const week = usage?.utilization?.seven_day;

  const reset = Date.parse(session?.resets_at);
  // After the reset time the cached number is stale; the new window starts at 0.
  const used = session?.utilization == null ? null : reset && Date.now() > reset ? 0 : session.utilization;

  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**Claude Usage Meter** · limit ${limit}%\n\n`);
  if (used != null) tip.appendMarkdown(`Session (5h): ${Math.round(used)}%${reset ? ` · resets in ${timeLeft(reset)}` : ''}\n\n`);
  if (week?.utilization != null) tip.appendMarkdown(`Week: ${Math.round(week.utilization)}%\n\n`);
  if (usage?.fetchedAtMs) tip.appendMarkdown(`Updated ${new Date(usage.fetchedAtMs).toLocaleTimeString()}\n\n`);
  if (refreshError) tip.appendMarkdown(`Auto refresh failed: ${refreshError}\n\n`);
  tip.appendMarkdown(`Source: \`${file.replace(os.homedir(), '~')}\``);
  item.tooltip = tip;

  if (used == null) {
    item.text = '$(pulse) Session --%';
    item.color = undefined;
    item.backgroundColor = undefined;
    item.show();
    return;
  }

  const ratio = Math.min(used / limit, 1);
  item.text = `$(pulse) Session ${Math.round(used)}% / ${limit}%`;
  if (ratio >= 1) {
    item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    item.color = gradient(ratio);
    item.backgroundColor = undefined;
  }
  item.show();
}

async function setLimit() {
  const cfg = vscode.workspace.getConfiguration('usageMeter');
  const value = await vscode.window.showInputBox({
    prompt: 'Usage limit (%) at which the badge turns red',
    value: String(cfg.get('limitPercent', 90)),
    validateInput: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 100 ? null : 'Enter a number from 1 to 100'),
  });
  if (value) await cfg.update('limitPercent', Number(value), vscode.ConfigurationTarget.Global);
}

function deactivate() {}

module.exports = { activate, deactivate };
