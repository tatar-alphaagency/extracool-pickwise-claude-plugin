// pickwise tests: run with `node tests/pickwise.test.js`. Uses a temporary home folder.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const P = path.join(__dirname, '..', 'scripts');
const T = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pickwise-test-'));

const env = { ...process.env, USERPROFILE: T, HOME: T };
const run = (mode, obj) =>
  spawnSync('node', [`${P}/pickwise.js`, mode], { input: JSON.stringify(obj), env, encoding: 'utf8' }).stdout;
const decision = (s) => (s ? JSON.parse(s).hookSpecificOutput.permissionDecision : 'allow');
const S = { session_id: 's1' };
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`);
};

const ctx = JSON.parse(run('session-start', {})).hookSpecificOutput.additionalContext;
check('session-start has model rules', ctx.includes('pickwise: subagent models'), true);
check('session-start has browser rules', ctx.includes('(none registered yet)'), true);

check('fable without token', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'fable' } })), 'deny');
run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: 'User answered: "q"="Use Opus instead (Recommended)"' });
check('opus answer gives no token', fs.existsSync(path.join(T, '.claude/pickwise/state/approved-fable')), false);
run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: 'User answered: "q"="Use Fable"' });
check('fable answer (string) gives token', fs.existsSync(path.join(T, '.claude/pickwise/state/approved-fable')), true);
check('fable with token', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'fable' } })), 'allow');
check('token is one use', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'fable' } })), 'deny');
run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: { answers: { q: 'Use Fable' } } });
check('fable answer (input.answers) gives token', fs.existsSync(path.join(T, '.claude/pickwise/state/approved-fable')), true);
check('workflow fable uses token', decision(run('pre-tool', { ...S, tool_name: 'Workflow', tool_input: { script: "agent(p,{model:'fable'})" } })), 'allow');
check('workflow fable no token', decision(run('pre-tool', { ...S, tool_name: 'Workflow', tool_input: { script: "agent(p,{model:'fable'})" } })), 'deny');
check('sonnet passes', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'sonnet' } })), 'allow');

const C = 'mcp__claude-in-chrome__';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
check('list_connected_browsers passes', decision(run('pre-tool', { ...S, tool_name: C + 'list_connected_browsers', tool_input: {} })), 'allow');
check('navigate with nothing selected', decision(run('pre-tool', { ...S, tool_name: C + 'navigate', tool_input: {} })), 'deny');
check('switch_browser blocked', decision(run('pre-tool', { ...S, tool_name: C + 'switch_browser', tool_input: {} })), 'deny');
check('select unregistered', decision(run('pre-tool', { ...S, tool_name: C + 'select_browser', tool_input: { deviceId: ID } })), 'deny');

// registration: probe running allows select of unregistered; a hit registers it
const probe = require('child_process').spawn('node', [`${P}/browser-probe.js`, 'serve', '30', '47899'], { env });
setTimeout(async () => {
  const cfg = path.join(T, '.claude/pickwise/config.json');
  fs.writeFileSync(cfg, JSON.stringify({ browser: { probePort: 47899 } }));
  check('select unregistered while probe runs', decision(run('pre-tool', { ...S, tool_name: C + 'select_browser', tool_input: { deviceId: ID } })), 'allow');
  await new Promise((r) =>
    http.get({ host: '127.0.0.1', port: 47899, path: `/?id=${ID}`, headers: { 'user-agent': 'Mozilla/5.0 Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0' } }, (res) => {
      res.resume();
      res.on('end', r);
    })
  );
  await new Promise((r) => http.get({ host: '127.0.0.1', port: 47899, path: '/quit' }, (res) => { res.resume(); res.on('end', r); }));
  await new Promise((r) => setTimeout(r, 300));
  const reg = JSON.parse(fs.readFileSync(path.join(T, `.claude/pickwise/browsers/${require('os').hostname()}.json`), 'utf8'));
  check('probe hit registered as Edge', reg.browsers[0] && reg.browsers[0].label.startsWith('Edge ('), true);
  check('select registered (probe stopped)', decision(run('pre-tool', { ...S, tool_name: C + 'select_browser', tool_input: { deviceId: ID } })), 'allow');
  run('post-tool', { ...S, tool_name: C + 'select_browser', tool_input: { deviceId: ID } });
  check('navigate after select', decision(run('pre-tool', { ...S, tool_name: C + 'navigate', tool_input: {} })), 'allow');
  check('other session not selected yet', decision(run('pre-tool', { session_id: 's2', tool_name: C + 'navigate', tool_input: {} })), 'deny');
  const ctx2 = JSON.parse(run('session-start', {})).hookSpecificOutput.additionalContext;
  check('session-start lists registered browser', ctx2.includes(ID), true);
  fs.writeFileSync(cfg, JSON.stringify({ model: { enabled: false }, browser: { enabled: false, probePort: 47899 } }));
  check('disabled: fable passes', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'fable' } })), 'allow');
  check('disabled: session-start silent', run('session-start', {}), '');
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
  probe.kill();
  process.exit(fail ? 1 : 0);
}, 700);
