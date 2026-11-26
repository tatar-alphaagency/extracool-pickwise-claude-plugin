#!/usr/bin/env node
// pickwise hook entry point.
// Usage: node pickwise.js <session-start|user-prompt|pre-tool|post-tool|tool-failed|subagent-stop>
//        (hook JSON on stdin)
//
// session-start: injects the model and browser rules (with this computer's
//                browser registry) into Claude's context.
// user-prompt:   every new user message clears the browser pick and selection,
//                so each task asks the user again which browser to use.
// pre-tool:      Agent/Task/Workflow -> gated models (default: fable) need a
//                one-time approval token; Claude in Chrome tools -> only
//                browsers registered for this computer, and select_browser
//                only for a browser the user picked in this task.
//                Agent/Task also claim one of maxParallel slots per session;
//                no free slot -> deny until a running subagent finishes.
// post-tool:     AskUserQuestion -> "Use <Model>" answer writes the token, and
//                an answer naming a registered browser records the pick;
//                select_browser -> remembers the selected browser per session;
//                Agent/Task -> a finished foreground call frees its slot, a
//                background launch tags its slot with the agentId.
// tool-failed:   PostToolUseFailure / PermissionDenied on Agent/Task -> frees the slot.
// subagent-stop: a background subagent finished -> frees the slot with its agentId.
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
  parallel: { enabled: true, maxParallel: 4, slotMinutes: 60 },
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
    parallel: { ...DEFAULTS.parallel, ...(user.parallel || {}) },
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
const selectedFile = (sid) => path.join(STATE_DIR, `browser-${sid}.json`);
const pickFile = (sid) => path.join(STATE_DIR, `browser-pick-${sid}.json`);
const slotFile = (sid, i) => path.join(STATE_DIR, `slot-${sid}-${i}.json`);
const stoppedFile = (agentId) => path.join(STATE_DIR, `stopped-${agentId}`);
const maxSlots = (p) => Math.max(1, Math.floor(Number(p.maxParallel) || 1));

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

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

// ---------- parallel slots ----------
// One file per running subagent: slot-<session>-<i>.json, i < maxParallel.
// Exclusive create ('wx') makes a claim atomic, so Agent calls sent in one
// message (their hooks run at the same time) cannot take the same slot.

function slotFiles() {
  try {
    return fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.startsWith('slot-'))
      .map((f) => path.join(STATE_DIR, f));
  } catch {
    return [];
  }
}

function claimSlot(p, sid, toolUseId) {
  ensureDir(STATE_DIR);
  const ttl = Number(p.slotMinutes) * 60 * 1000;
  for (let i = 0; i < maxSlots(p); i++) {
    const f = slotFile(sid, i);
    try {
      // a slot older than slotMinutes was never freed (crash, stopped task): reuse it
      if (Date.now() - fs.statSync(f).mtimeMs > ttl) fs.unlinkSync(f);
    } catch {
      // free slot
    }
    try {
      fs.writeFileSync(f, JSON.stringify({ toolUseId, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch {
      // taken
    }
  }
  return false;
}

function releaseSlots(match) {
  for (const f of slotFiles()) {
    const s = readJson(f);
    if (s && match(s)) {
      try {
        fs.unlinkSync(f);
      } catch {
        // already freed
      }
    }
  }
}

function tagSlot(toolUseId, agentId) {
  if (fs.existsSync(stoppedFile(agentId))) {
    // the subagent already finished before its launch result arrived
    return releaseSlots((s) => s.toolUseId === toolUseId);
  }
  for (const f of slotFiles()) {
    const s = readJson(f);
    if (s && s.toolUseId === toolUseId) fs.writeFileSync(f, JSON.stringify({ ...s, agentId }));
  }
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
    '- Before the first Claude in Chrome action of EVERY user message (each new task), even if a browser was used',
    '  earlier or the user already named one: call `list_connected_browsers`, keep the registered browsers that are',
    '  connected, ask the user with AskUserQuestion which one to use (option label exactly as in the list above,',
    '  deviceId in the description; multiSelect if the task needs more than one browser), then `select_browser` it.',
    '- Subagents cannot ask the user: ask in the main chat first, then give the subagent the chosen deviceId.',
    '- None registered or none connected: stop, tell the user, and offer the `pickwise:browser` skill to register.',
    `- Registration uses the probe script \`${PROBE_SCRIPT}\` on port ${b.probePort} (see the pickwise:browser skill).`,
    '- A pickwise hook clears the browser choice on every new user message. It blocks `select_browser` unless the user',
    '  picked that browser in an AskUserQuestion during the current message, and blocks other Claude in Chrome tools',
    '  until such a browser is selected.',
  ].join('\n');
}

function parallelContext(p) {
  const n = maxSlots(p);
  return [
    '## pickwise: parallel subagents',
    "- Independent tasks (none needs another's result, no two edit the same files): send all their Agent calls in ONE",
    '  message, so they run at the same time. Each call still sets its own `model`.',
    "- A task that needs another task's result: wait for that result first.",
    '- Two subagents that edit the same files: never at the same time. Run them one after the other, or give each',
    '  `isolation: "worktree"`.',
    `- At most ${n} subagents run at once in this session. A pickwise hook denies the Agent call past ${n}. Then wait`,
    '  for a running subagent to finish and retry, or do that work yourself.',
    `- In a Workflow script, keep at most ${n} agent() calls running at once.`,
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
  if (cfg.parallel.enabled) parts.push(parallelContext(cfg.parallel));
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

  if (['Agent', 'Task', 'Workflow'].includes(name)) {
    const p = cfg.parallel;
    const toolUseId = String(input.tool_use_id || `none-${process.pid}-${Date.now()}`);
    const counted = p.enabled && name !== 'Workflow';
    if (counted && !claimSlot(p, input.session_id || 'none', toolUseId)) {
      const n = maxSlots(p);
      deny(
        `${n} subagents are already running in this session (maxParallel ${n}). Wait for one to finish, then retry this call, ` +
          'or do this work yourself. Change the limit with "parallel": {"maxParallel": N} in ~/.claude/pickwise/config.json.'
      );
    }
    if (!cfg.model.enabled) process.exit(0);
    const m = cfg.model;
    const gated = m.gatedModels.map((g) => g.toLowerCase());
    const hit = requestedGated(input, gated);
    if (!hit || consumeToken(hit, m.approvalMinutes)) process.exit(0);
    if (counted) releaseSlots((s) => s.toolUseId === toolUseId);
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
    const ask =
      'Call list_connected_browsers, ask the user with AskUserQuestion which registered browser of ' +
      `${HOST} to use (option label exactly as registered, e.g. "${(reg[0] && reg[0].label) || `Edge (${HOST})`}"), then select_browser it.`;
    if (tool === 'select_browser') {
      const id = String((input.tool_input || {}).deviceId || '');
      if (registering) process.exit(0);
      if (!known(id)) {
        deny(
          `deviceId ${id} is not registered for this computer (${HOST}). Pick one from the registered list and ask the user, ` +
            'or register browsers with the pickwise:browser skill.'
        );
      }
      const picks = (readJson(pickFile(input.session_id)) || {}).deviceIds || [];
      if (picks.includes(id)) process.exit(0);
      deny(`the user has not picked this browser for the current message. The choice resets on every new message. ${ask}`);
    }
    const selected = (readJson(selectedFile(input.session_id)) || {}).deviceId || '';
    if (known(selected) || registering) process.exit(0);
    deny(`no browser picked by the user is selected for the current message. ${ask}`);
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
  const vals = name === 'AskUserQuestion' ? answerValues(input).map((v) => v.toLowerCase()) : [];
  if (cfg.model.enabled && name === 'AskUserQuestion') {
    for (const g of cfg.model.gatedModels.map((x) => x.toLowerCase())) {
      if (vals.includes(`use ${g}`)) {
        ensureDir(STATE_DIR);
        fs.writeFileSync(path.join(STATE_DIR, `approved-${g}`), String(Date.now()));
      }
    }
  }
  if (cfg.browser.enabled && name === 'AskUserQuestion' && input.session_id) {
    // An answer that contains a registered label or deviceId is a pick
    // (multiSelect answers arrive joined, so match by substring).
    const hits = loadRegistry()
      .filter((b) => vals.some((v) => v.includes(String(b.label).toLowerCase()) || v.includes(String(b.deviceId).toLowerCase())))
      .map((b) => b.deviceId);
    if (hits.length) {
      const prev = (readJson(pickFile(input.session_id)) || {}).deviceIds || [];
      ensureDir(STATE_DIR);
      fs.writeFileSync(
        pickFile(input.session_id),
        JSON.stringify({ deviceIds: [...new Set([...prev, ...hits])], at: Date.now() })
      );
    }
  }
  if (cfg.parallel.enabled && (name === 'Agent' || name === 'Task') && input.tool_use_id) {
    const id = String(input.tool_use_id);
    const tr = input.tool_response;
    const text = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
    if (/async_launched/.test(text)) {
      // background launch: the slot stays taken until SubagentStop names this agentId
      const agentId =
        (tr && typeof tr === 'object' && tr.agentId) || (text.match(/agentId\W+([A-Za-z0-9_-]+)/) || [])[1];
      if (agentId) tagSlot(id, String(agentId));
    } else {
      releaseSlots((s) => s.toolUseId === id);
    }
  }
  if (cfg.browser.enabled && name === `${CHROME}select_browser`) {
    const id = String((input.tool_input || {}).deviceId || '');
    if (id && input.session_id) {
      ensureDir(STATE_DIR);
      fs.writeFileSync(selectedFile(input.session_id), JSON.stringify({ deviceId: id, at: Date.now() }));
    }
  }
  process.exit(0);
}

function toolFailed(cfg, input) {
  if (cfg.parallel.enabled && input.tool_use_id) {
    const id = String(input.tool_use_id);
    releaseSlots((s) => s.toolUseId === id);
  }
  process.exit(0);
}

function subagentStop(cfg, input) {
  const agentId = String(input.agent_id || '');
  if (cfg.parallel.enabled && agentId) {
    ensureDir(STATE_DIR);
    fs.writeFileSync(stoppedFile(agentId), String(Date.now()));
    releaseSlots((s) => s.agentId === agentId);
  }
  process.exit(0);
}

// ---------- user-prompt ----------

function userPrompt(cfg, input) {
  if (cfg.browser.enabled && input.session_id) {
    for (const f of [pickFile(input.session_id), selectedFile(input.session_id)]) {
      try {
        fs.unlinkSync(f);
      } catch {
        // nothing to clear
      }
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
    if (mode === 'user-prompt') return userPrompt(cfg, input);
    if (mode === 'pre-tool') return preTool(cfg, input).catch(() => process.exit(0));
    if (mode === 'post-tool') return postTool(cfg, input);
    if (mode === 'tool-failed') return toolFailed(cfg, input);
    if (mode === 'subagent-stop') return subagentStop(cfg, input);
  } catch {
    // never break the session on a hook error
  }
  process.exit(0);
});
