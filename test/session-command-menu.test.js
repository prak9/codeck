import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionCommandOutput } from '../public/remote-command-output.js';
import { sendSessionMessage, selectSessionCommand, selectSessionModel } from '../src/tmux.js';

const target = { provider: 'codex', sessionName: 'work', threadId: 'thread-1' };
const idle = '› \n\n  gpt-6-astra · /data/codeck';
const menu = 'Usage\nView account usage or redeem an earned reset.\n› 1. Show usage  View recent usage\n  2. Redeem usage limit reset  You have 2 resets\nPress enter to confirm or esc to go back';
const sessions = async () => [{ name: 'work', agent: { kind: 'codex', id: 'thread-1', paneId: '%7' } }];

test('/usage returns all choices without implicitly redeeming or selecting anything', async () => {
  const calls = [];
  const result = await sendSessionMessage({ ...target, text: '/usage' }, {
    listTmuxSessions: sessions, capturePane: async () => menu,
    execTmux: async args => calls.push(args), waitForSlashOutput: async () => {},
  });
  assert.match(result.terminalOutput, /Redeem usage limit reset/);
  assert.deepEqual(calls, []);
  const output = normalizeSessionCommandOutput('codex', '/usage', result);
  assert.equal(output.kind, 'commandSelection');
  assert.equal(output.parsed.items.length, 2);
});

for (const [command, heading] of [['/status', 'Status'], ['/clear', 'Clear conversation?']]) {
  test(`${command} confirmation choices are actionable, ordinary output stays read-only`, () => {
    const terminalOutput = `${heading}\n› 1. Confirm  Continue\n  2. Cancel  Go back\nPress enter to confirm or esc to go back`;
    assert.equal(normalizeSessionCommandOutput('codex', command, { terminalOutput }).kind, 'commandSelection');
    assert.equal(normalizeSessionCommandOutput('codex', command, { terminalOutput: 'Model: gpt-6\nUsage: 25%' }).kind, 'output');
  });
}

test('selection waits for cursor movement, exits copy-mode and returns asynchronous results', async () => {
  const calls = [];
  let moved = false, submitted = false;
  const result = await selectSessionCommand({ ...target, command: '/usage', option: 'Redeem usage limit reset', menuText: menu }, {
    listTmuxSessions: sessions,
    capturePane: async () => submitted ? '/usage daily\nToken activity\nLifetime 19B\n' + idle
      : moved ? menu.replace('› 1.', '  1.').replace('  2.', '› 2.') : menu,
    execTmux: async args => { calls.push(args); if (args.at(-1) === 'Down') moved = true; if (args.at(-1) === 'Enter') submitted = true; },
    waitForSlashOutput: async () => {},
  });
  assert.match(result.terminalOutput, /Lifetime 19B/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => args[0] === 'copy-mode'));
});

test('a stale confirmation cannot operate a replacement menu', async () => {
  const calls = [];
  await assert.rejects(selectSessionCommand({ ...target, command: '/usage', option: 'Show usage', menuText: menu }, {
    listTmuxSessions: sessions, capturePane: async () => menu.replace('You have 2 resets', 'You have 1 reset'),
    execTmux: async args => calls.push(args),
  }), /变化/);
  assert.deepEqual(calls, []);
});

test('history containing a menu followed by a composer is never interactive', () => {
  assert.equal(normalizeSessionCommandOutput('codex', '/usage', { terminalOutput: menu + '\n' + idle }).kind, 'output');
});

test('Codex 0.165 usage footer and choices are selectable', () => {
  const terminalOutput = 'Usage\nAccount usage and resets.\n› 1. View analytics  Usage history\n  2. Redeem reset  Check availability\nenter open · esc back';
  const result = normalizeSessionCommandOutput('codex', '/usage', { terminalOutput });
  assert.equal(result.kind, 'commandSelection');
  assert.deepEqual(result.parsed.items.map(item => item.label), ['View analytics', 'Redeem reset']);
});

test('current reasoning picker supports applying to the session instead of changing defaults', async () => {
  const screen = 'Select Reasoning Level for GPT-6.1-Sol\n› 1. Low (default) (current)  Fast\n2. Medium  Balanced\nenter default · s session · esc back';
  const calls = [];
  const result = await selectSessionModel({ ...target, option: 'Low (default)', scope: 'session' }, {
    listTmuxSessions: sessions, capturePane: async () => calls.length ? idle : screen,
    execTmux: async args => calls.push(args), waitForSlashOutput: async () => {},
  });
  assert.equal(result.completed, true);
  assert.equal(calls[0].at(-1), 's');
});

test('/status excludes an old update box and preserves the full inline result', async () => {
  let sent = false;
  const result = await sendSessionMessage({ ...target, text: '/status' }, {
    listTmuxSessions: sessions, capturePane: async () => !sent ? idle
      : '╭────────────╮\n│ Update now │\n╰────────────╯\n/status\n>_ OpenAI Codex\nModel: GPT-6.1-Sol\n' + Array.from({ length: 40 }, (_, i) => `Status field ${i}`).join('\n') + '\n' + idle,
    execTmux: async () => { sent = true; }, waitForPaste: async () => {}, waitForSlashOutput: async () => {},
  });
  assert.doesNotMatch(result.terminalOutput, /Update now/);
  assert.match(result.terminalOutput, /Status field 0/);
  assert.match(result.terminalOutput, /Status field 39/);
});

const dashboard = 'Usage · Pro · demo\n1 Overview   2 Usage   3 Messages   4 Plugins   5 Skills   6 Chats\ng Daily\nLifetime 19B\nesc back\ntab/1–6 report · z dashboard · ? help · R refresh';
test('usage analytics preserves the screen and exposes native report tabs', async () => {
  const normalized = normalizeSessionCommandOutput('codex', '/usage', { terminalOutput: dashboard });
  assert.equal(normalized.parsed.dashboard, true);
  assert.deepEqual(normalized.parsed.items.slice(0, 6).map(item => item.key), ['1', '2', '3', '4', '5', '6']);
  const calls = [];
  const result = await selectSessionCommand({ ...target, command: '/usage', option: '消息', menuText: dashboard }, {
    listTmuxSessions: sessions, capturePane: async () => calls.length ? dashboard.replace('Lifetime 19B', 'Messages report') : dashboard,
    execTmux: async args => calls.push(args), waitForSlashOutput: async () => {},
  });
  assert.match(result.terminalOutput, /Messages report/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), '3');
});

test('opening analytics returns its live dashboard rather than waiting for a composer', async () => {
  const calls = [];
  const result = await selectSessionCommand({ ...target, command: '/usage', option: 'Show usage', menuText: menu }, {
    listTmuxSessions: sessions, capturePane: async () => calls.length ? dashboard : menu,
    execTmux: async args => calls.push(args), waitForSlashOutput: async () => {},
  });
  assert.equal(result.terminalOutput, dashboard);
});

test('a command write with unknown delivery is not repeated or reported successful', async () => {
  let writes = 0;
  const result = await selectSessionCommand({ ...target, command: '/usage', option: 'Show usage', menuText: menu }, {
    listTmuxSessions: sessions, capturePane: async () => menu,
    execTmux: async () => { writes++; throw new Error('connection lost'); }, waitForSlashOutput: async () => {},
  });
  assert.deepEqual(result, { unconfirmed: true });
  assert.equal(writes, 1);
});

test('a model menu from a different reasoning stage cannot select the same label', async () => {
  const old = 'Select Reasoning Level for model-a\n› 1. Low  Fast\n2. High  Deep\nenter default · s session · esc back';
  await assert.rejects(selectSessionModel({ ...target, option: 'Low', menuText: old }, {
    listTmuxSessions: sessions, capturePane: async () => old.replace('model-a', 'model-b'),
    execTmux: async () => assert.fail('stale stage must not receive keys'),
  }), /变化/);
});

test('usage help can return to analytics and cannot leak keys to a composer', async () => {
  const help = dashboard.replace('Lifetime 19B', 'Usage shortcuts').replace(/tab\/1–6 report.*$/, '? close help');
  const parsed = normalizeSessionCommandOutput('codex', '/usage', { terminalOutput: help }).parsed;
  assert.deepEqual(parsed.items, [{ label: '返回用量', description: '', key: '?' }]);
  await assert.rejects(selectSessionCommand({ ...target, command: '/usage', option: '刷新', menuText: dashboard }, {
    listTmuxSessions: sessions, capturePane: async () => dashboard + '\n' + idle,
    execTmux: async () => assert.fail('composer must not receive dashboard shortcuts'),
  }), /变化/);
});

test('closing usage exits help, analytics and the chooser before returning control', async () => {
  const { dismissSessionCommand } = await import('../src/tmux.js');
  const help = dashboard.replace(/tab\/1–6 report.*$/, '? close help');
  const screens = [help, dashboard, menu, idle];
  let writes = 0;
  assert.deepEqual(await dismissSessionCommand({ ...target, command: '/usage' }, {
    listTmuxSessions: sessions, capturePane: async () => screens[writes],
    execTmux: async args => { assert.equal(args.at(-1), 'Escape'); writes++; }, waitForSlashOutput: async () => {},
  }), { dismissed: true });
  assert.equal(writes, 3);
});

test('a delayed dismissal never repeats Escape against an unchanged frame', async () => {
  const { dismissSessionCommand } = await import('../src/tmux.js');
  let writes = 0;
  await assert.rejects(dismissSessionCommand({ ...target, command: '/usage' }, {
    listTmuxSessions: sessions, capturePane: async () => dashboard,
    execTmux: async () => { writes++; }, waitForSlashOutput: async () => {},
  }), /尚未确认关闭/);
  assert.equal(writes, 1);
});

test('the real 37-column usage dashboard has abbreviated tabs and footer', () => {
  const terminalOutput = 'Usage · Pro · demo\nOverview   Usage   Messages      ›\n────────────────────────────\ng Daily\nLifetime tokens\npgup/pgdn scroll · esc back\ntab report · z all · ? · R refresh';
  const output = normalizeSessionCommandOutput('codex', '/usage', { terminalOutput });
  assert.equal(output.parsed.dashboard, true);
  assert.equal(output.parsed.items.find(item => item.label === '下一页').key, 'NPage');
});

test('usage reset lists remain selectable and unavailable resets remain readable', () => {
  const terminalOutput = 'Usage limit resets\n› 1. Reset five-hour limit  One available\n2. Cancel  Go back\nenter choose · esc back';
  const choices = normalizeSessionCommandOutput('codex', '/usage', { terminalOutput });
  assert.equal(choices.kind, 'commandSelection');
  assert.equal(choices.parsed.items.length, 2);
  const unavailable = normalizeSessionCommandOutput('codex', '/usage', {
    terminalOutput: 'Usage limit resets\nNo usage limit resets are available.\nesc back',
  });
  assert.equal(unavailable.kind, 'output');
  assert.equal(unavailable.dismissible, true);
  assert.equal(unavailable.parsed.info, true);
});

for (const resetIdentity of [true, false]) {
  test(`/clear reports success only after a verified new CLI thread (${resetIdentity})`, async () => {
    let submitted = false, enters = 0;
    const result = await sendSessionMessage({ ...target, text: '/clear' }, {
      listTmuxSessions: async () => [{ name: 'work', agent: {
        kind: 'codex', id: submitted && resetIdentity ? 'thread-new' : 'thread-1', paneId: '%7',
      } }],
      capturePane: async () => submitted ? '>_ OpenAI Codex\nTip: Start a task\n' + idle : 'Previous conversation\n' + idle,
      execTmux: async args => { if (args.at(-1) === 'Enter') { submitted = true; enters++; } },
      waitForPaste: async () => {}, waitForSlashOutput: async () => {},
    });
    assert.equal(result.completed === true, resetIdentity);
    assert.equal(enters, 1, 'clear is never automatically resent');
    if (resetIdentity) assert.equal(result.terminalOutput, '已清空当前对话。');
  });
}
