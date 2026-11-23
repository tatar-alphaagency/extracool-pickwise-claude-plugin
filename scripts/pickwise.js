#!/usr/bin/env node
// pickwise hook entry point.
// Usage: node pickwise.js <session-start|pre-tool|post-tool>   (hook JSON on stdin)
//
// session-start: injects the model and browser rules (with this computer's
//                browser registry) into Claude's context.
// pre-tool:      Agent/Task/Workflow -> gated models (default: fable) need a
//                one-time approval token; Claude in Chrome tools -> only
//                browsers registered for this computer.
// post-tool:     AskUserQuestion -> "Use <Model>" answer writes the token;
//                select_browser -> remembers the selected browser per session.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const DATA_DIR = path.join(os.homedir(), '.claude', 'pickwise');
const STATE_DIR = path.join(DATA_DIR, 'state');
const BROWSER_DIR = path.join(DATA_DIR, 'browsers');
const HOST = os.hostname();
const REGISTRY = path.join(BROWSER_DIR, `${HOST}.json`);
const CHROME = 'mcp__claude-in-chrome__';
const PROBE_SCRIPT = path.join(__dirname, 'browser-probe.js').replace(/\\/g, '/');

const DEFAULTS = {
  model: {
    enabled: true,
    gatedModels: ['fable'],
    fallbackModel: 'opus',
    approvalMinutes: 10,
    routing: {
      haiku: 'search, locate code, list files, read and summarize, 1-2 file mechanical edits, web fetch',
      sonnet: 'implement from a clear plan, write tests, code review, audits, most multi-file work',
      opus: 'architecture, hard debugging, security review, writing plans, tasks where sonnet already failed',
    },
  },
  browser: { enabled: true, probePort: 47831 },
};

function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  } catch {
    // no config file: defaults
  }
  const um = user.model || {};
  return {
    model: { ...DEFAULTS.model, ...um, routing: { ...DEFAULTS.model.routing, ...(um.routing || {}) } },
    browser: { ...DEFAULTS.browser, ...(user.browser || {}) },
  };
}

function loadRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return Array.isArray(r.browsers) ? r.browsers : [];
  } catch {
    return [];
  }
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const fwd = (p) => p.replace(/\\/g, '/');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function deny(reason) {
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[pickwise] ${reason}`,
    },
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(400, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// ---------- session-start ----------

function modelContext(m) {
  const fb = cap(m.fallbackModel);
  const gated = m.gatedModels.map((g) => g.toLowerCase());
  const lines = [
    '## pickwise: subagent models',
    '- Every Agent tool call, and every agent() call in a Workflow script: set `model` explicitly.',
    '  Pick the cheapest model that does the task well:',
    ...Object.entries(m.routing).map(([k, v]) => `  - \`${k}\`: ${v}.`),
    '- Work that needs only a few tool calls: do it yourself, do not spawn a subagent.',
  ];
  if (gated.length) {
    lines.push(
      `- Gated models, never used without the user's OK: ${gated.map((g) => `\`${g}\``).join(', ')}.`,
      `  Only when a task truly needs one, BEFORE the call ask with AskUserQuestion: say why ${m.fallbackModel} is not enough,`,
      `  options exactly "Use ${fb} instead (Recommended)", "Use <Model>" (e.g. "Use ${cap(gated[0])}"), "Cancel". Then, in the same turn:`,
      `  "Use <Model>" -> make that one call; "Use ${fb} instead" -> the same call with model ${m.fallbackModel}; "Cancel" -> stop that task.`,
      `  A pickwise hook denies a gated call unless the user picked "Use <Model>" in the last ${m.approvalMinutes} minutes (one use).`
    );
  }
  return lines.join('\n');
}

function browserContext(b) {
  const reg = loadRegistry();
  const list = reg.length
    ? reg.map((x) => `  - ${x.label} - deviceId \`${x.deviceId}\``).join('\n')
    : '  - (none registered yet)';
  return [
    '## pickwise: Claude in Chrome browser',
    `- This computer: \`${HOST}\`. Use only browsers registered for it (${fwd(REGISTRY)}):`,
    list,
    '- Names like "Browser 1" change between sessions: go by deviceId only. Never call `switch_browser`.',
    '- Before the first Claude in Chrome action in a session: call `list_connected_browsers`, keep the registered',
    '  browsers that are connected, ask the user with AskUserQuestion which one to use (label from the list above,',
    '  deviceId in the description), then `select_browser` it. Ask again only if the user wants to change browser.',
    '- None registered or none connected: stop, tell the user, and offer the `pickwise:browser` skill to register.',
    `- Registration uses the probe script \`${PROBE_SCRIPT}\` on port ${b.probePort} (see the pickwise:browser skill).`,
    '- A pickwise hook blocks Claude in Chrome tools until a registered browser is selected in this session.',
  ].join('\n');
}

function sessionStart(cfg) {
  // drop old per-session state (older than 3 days)
  try {
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    // no state dir yet
  }
  const parts = [];
  if (cfg.model.enabled) parts.push(modelContext(cfg.model));
  if (cfg.browser.enabled) parts.push(browserContext(cfg.browser));
  if (!parts.length) process.exit(0);
  out({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  });
}

// ---------- pre-tool ----------

function requestedGated(input, gated) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    const m = String(ti.model || '').toLowerCase();
    return gated.find((g) => m.includes(g)) || null;
  }
  if (input.tool_name === 'Workflow') {
    const s = String(ti.script || '');
    return (
      gated.find((g) => new RegExp(`model\\s*:\\s*['"\`][^'"\`]*${g}`, 'i').test(s)) || null
    );
  }
  return null;
}

function consumeToken(model, minutes) {
  const f = path.join(STATE_DIR, `approved-${model}`);
  try {
    const ts = Number(fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);
    return Date.now() - ts < minutes * 60 * 1000;
  } catch {
    return false;
  }
}

async function preTool(cfg, input) {
  const name = String(input.tool_name || '');

  if (cfg.model.enabled && ['Agent', 'Task', 'Workflow'].includes(name)) {
    const m = cfg.model;
    const gated = m.gatedModels.map((g) => g.toLowerCase());
    const hit = requestedGated(input, gated);
    if (!hit || consumeToken(hit, m.approvalMinutes)) process.exit(0);
    deny(
      `${cap(hit)} needs the user's approval in chat first. Call AskUserQuestion: say why ${m.fallbackModel} is not enough, ` +
        `options exactly "Use ${cap(m.fallbackModel)} instead (Recommended)", "Use ${cap(hit)}", "Cancel". ` +
        `"Use ${cap(hit)}" -> retry this same call. "Use ${cap(m.fallbackModel)} instead" -> the same call with model ${m.fallbackModel}. ` +
        '"Cancel" -> stop the task.'
    );
  }

  if (cfg.browser.enabled && name.startsWith(CHROME)) {
    const tool = name.slice(CHROME.length);
    const reg = loadRegistry();
    const known = (id) => reg.some((x) => x.deviceId === id);
    const registering = await portOpen(cfg.browser.probePort);

    if (tool === 'list_connected_browsers') process.exit(0);
    if (tool === 'switch_browser') {
      deny('switch_browser is blocked: it can reach browsers on other computers. Use list_connected_browsers, ask the user, then select_browser.');
    }
    if (tool === 'select_browser') {
      const id = String((input.tool_input || {}).deviceId || '');
      if (known(id) || registering) process.exit(0);
      deny(
        `deviceId ${id} is not registered for this computer (${HOST}). Pick one from the registered list and ask the user, ` +
          'or register browsers with the pickwise:browser skill.'
      );
    }
    let selected = '';
    try {
      selected = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `browser-${input.session_id}.json`), 'utf8')).deviceId;
    } catch {
      // nothing selected this session
    }
    if (known(selected) || registering) process.exit(0);
    deny(
      'no registered browser is selected in this session. Call list_connected_browsers, ask the user with AskUserQuestion ' +
        `which registered browser of ${HOST} to use, then select_browser it.`
    );
  }
  process.exit(0);
}

// ---------- post-tool ----------

function answerValues(input) {
  const vals = [];
  const take = (a) => {
    if (a && typeof a === 'object') vals.push(...Object.values(a).map(String));
  };
  const ti = input.tool_input || {};
  const tr = input.tool_response;
  take(ti.answers);
  if (tr && typeof tr === 'object') take(tr.answers);
  const text = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
  for (const m of text.matchAll(/"="([^"]*)"/g)) vals.push(m[1]);
  return vals.map((v) => v.trim());
}

function postTool(cfg, input) {
  const name = String(input.tool_name || '');
  if (cfg.model.enabled && name === 'AskUserQuestion') {
    const vals = answerValues(input).map((v) => v.toLowerCase());
    for (const g of cfg.model.gatedModels.map((x) => x.toLowerCase())) {
      if (vals.includes(`use ${g}`)) {
        ensureDir(STATE_DIR);
        fs.writeFileSync(path.join(STATE_DIR, `approved-${g}`), String(Date.now()));
      }
    }
  }
  if (cfg.browser.enabled && name === `${CHROME}select_browser`) {
    const id = String((input.tool_input || {}).deviceId || '');
    if (id && input.session_id) {
      ensureDir(STATE_DIR);
      fs.writeFileSync(
        path.join(STATE_DIR, `browser-${input.session_id}.json`),
        JSON.stringify({ deviceId: id, at: Date.now() })
      );
    }
  }
  process.exit(0);
}

// ---------- main ----------

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  const cfg = loadConfig();
  const mode = process.argv[2];
  try {
    if (mode === 'session-start') return sessionStart(cfg);
    if (mode === 'pre-tool') return preTool(cfg, input).catch(() => process.exit(0));
    if (mode === 'post-tool') return postTool(cfg, input);
  } catch {
    // never break the session on a hook error
  }
  process.exit(0);
});
