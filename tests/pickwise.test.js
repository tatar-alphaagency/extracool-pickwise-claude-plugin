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
check('session-start has parallel rules (default 4)', ctx.includes('At most 4 subagents run at once'), true);

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
  const LABEL = reg.browsers[0].label;
  const sel = (sid) => decision(run('pre-tool', { session_id: sid, tool_name: C + 'select_browser', tool_input: { deviceId: ID } }));
  const nav = (sid) => decision(run('pre-tool', { session_id: sid, tool_name: C + 'navigate', tool_input: {} }));
  check('select registered without a pick', sel('s1'), 'deny');
  run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: 'User answered: "q"="Some other answer"' });
  check('unrelated answer is no pick', sel('s1'), 'deny');
  run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: `User answered: "Which browser?"="${LABEL}"` });
  check('select after user picked it', sel('s1'), 'allow');
  run('post-tool', { ...S, tool_name: C + 'select_browser', tool_input: { deviceId: ID } });
  check('navigate after select', nav('s1'), 'allow');
  check('other session not picked', sel('s2'), 'deny');
  check('other session not selected', nav('s2'), 'deny');
  run('user-prompt', S);
  check('new message: navigate blocked again', nav('s1'), 'deny');
  check('new message: select needs a new pick', sel('s1'), 'deny');
  run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: { answers: { 'Which browsers?': `${LABEL}, Chrome (OTHER)` } } });
  check('multiSelect answer picks it', sel('s1'), 'allow');
  run('user-prompt', S);
  run('post-tool', { ...S, tool_name: 'AskUserQuestion', tool_input: {}, tool_response: `User answered: "q"="Use the one with ${ID}"` });
  check('answer naming the deviceId picks it', sel('s1'), 'allow');
  const ctx2 = JSON.parse(run('session-start', {})).hookSpecificOutput.additionalContext;
  check('session-start lists registered browser', ctx2.includes(ID), true);
  // parallel slots: own session, limit 2
  fs.writeFileSync(cfg, JSON.stringify({ parallel: { maxParallel: 2 }, browser: { probePort: 47899 } }));
  const P1 = { session_id: 'p1' };
  const agent = (id, model = 'haiku') => decision(run('pre-tool', { ...P1, tool_name: 'Agent', tool_use_id: id, tool_input: { model } }));
  check('session-start shows maxParallel 2', JSON.parse(run('session-start', {})).hookSpecificOutput.additionalContext.includes('At most 2 subagents'), true);
  check('agent 1 of 2', agent('t1'), 'allow');
  check('agent 2 of 2', agent('t2'), 'allow');
  check('agent 3 over the limit', agent('t3'), 'deny');
  check('other session has its own slots', decision(run('pre-tool', { session_id: 'p2', tool_name: 'Agent', tool_use_id: 'q1', tool_input: { model: 'haiku' } })), 'allow');
  check('workflow is not counted', decision(run('pre-tool', { ...P1, tool_name: 'Workflow', tool_use_id: 'w1', tool_input: { script: "agent(p,{model:'haiku'})" } })), 'allow');
  run('post-tool', { ...P1, tool_name: 'Agent', tool_use_id: 't1', tool_input: {}, tool_response: { status: 'completed', agentId: 'a1', content: [] } });
  check('foreground finish frees a slot', agent('t3'), 'allow');
  check('full again', agent('t4'), 'deny');
  run('post-tool', { ...P1, tool_name: 'Agent', tool_use_id: 't2', tool_input: {}, tool_response: { status: 'async_launched', agentId: 'bg2' } });
  check('background launch keeps its slot', agent('t4'), 'deny');
  run('subagent-stop', { ...P1, agent_id: 'other' });
  check('unrelated SubagentStop frees nothing', agent('t4'), 'deny');
  run('subagent-stop', { ...P1, agent_id: 'bg2' });
  check('SubagentStop of that agent frees it', agent('t4'), 'allow');
  run('tool-failed', { ...P1, tool_name: 'Agent', tool_use_id: 't4', error: 'boom' });
  check('failed call frees its slot', agent('t5'), 'allow');
  run('subagent-stop', { ...P1, agent_id: 'fast' });
  run('post-tool', { ...P1, tool_name: 'Agent', tool_use_id: 't5', tool_input: {}, tool_response: 'status: async_launched, agentId: fast' });
  check('stop before launch result still frees', agent('t6'), 'allow');
  check('full before the gated test', agent('t7'), 'deny');
  run('post-tool', { ...P1, tool_name: 'Agent', tool_use_id: 't6', tool_input: {}, tool_response: { status: 'completed' } });
  check('fable without token denied', agent('t7', 'fable'), 'deny');
  check('slot not lost to the gated deny', agent('t8'), 'allow');
  const old = (Date.now() - 2 * 3600 * 1000) / 1000;
  for (const f of fs.readdirSync(path.join(T, '.claude/pickwise/state')).filter((f) => f.startsWith('slot-p1-'))) {
    fs.utimesSync(path.join(T, '.claude/pickwise/state', f), old, old);
  }
  check('stale slots are reused', agent('t9'), 'allow');
  const at = (id) =>
    new Promise((r) => {
      let o = '';
      const c = require('child_process').spawn('node', [`${P}/pickwise.js`, 'pre-tool'], { env });
      c.stdout.on('data', (d) => (o += d));
      c.on('close', () => r(decision(o)));
      c.stdin.end(JSON.stringify({ session_id: 'c1', tool_name: 'Agent', tool_use_id: id, tool_input: { model: 'haiku' } }));
    });
  const burst = await Promise.all(['c1', 'c2', 'c3', 'c4', 'c5'].map(at));
  check('5 calls at once, limit 2: 2 allowed', burst.filter((d) => d === 'allow').length, 2);
  fs.writeFileSync(cfg, JSON.stringify({ parallel: { enabled: false }, browser: { probePort: 47899 } }));
  check('parallel disabled: no limit', agent('t10') === 'allow' && agent('t11') === 'allow' && agent('t12') === 'allow', true);
  check('parallel disabled: no rules', JSON.parse(run('session-start', {})).hookSpecificOutput.additionalContext.includes('parallel subagents'), false);

  fs.writeFileSync(cfg, JSON.stringify({ model: { enabled: false }, browser: { enabled: false, probePort: 47899 }, parallel: { enabled: false } }));
  check('disabled: fable passes', decision(run('pre-tool', { ...S, tool_name: 'Agent', tool_input: { model: 'fable' } })), 'allow');
  check('disabled: session-start silent', run('session-start', {}), '');
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
  probe.kill();
  process.exit(fail ? 1 : 0);
}, 700);
