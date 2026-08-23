import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeSlashCommand,
  nextSlashCommandIndex,
  slashCommandKeyAction,
  slashCommandMenuAvailable,
  slashCommandSuggestions,
} from '../public/slash-commands.js';

test('slash command suggestions are prefix matched and provider aware', () => {
  assert.deepEqual(
    slashCommandSuggestions('codex', '/sta').map(({ command }) => command),
    ['/status', '/statusline'],
  );
  assert.deepEqual(
    slashCommandSuggestions('codex', '/ps').map(({ command }) => command),
    ['/ps'],
  );
  assert.deepEqual(
    slashCommandSuggestions('claude', '/doc').map(({ command }) => command),
    ['/doctor'],
  );
  assert.deepEqual(
    slashCommandSuggestions('qodercli', '/que').map(({ command }) => command),
    ['/quest'],
  );
});

test('slash command suggestions only cover the first command token', () => {
  assert.ok(slashCommandSuggestions('codex', '/').length > 0);
  assert.deepEqual(slashCommandSuggestions('codex', 'status'), []);
  assert.deepEqual(slashCommandSuggestions('codex', '/status '), []);
  assert.deepEqual(slashCommandSuggestions('codex', '/status now'), []);
  assert.deepEqual(slashCommandSuggestions('codex', '/sta\nnext'), []);
  assert.deepEqual(slashCommandSuggestions('shell', '/sta'), []);
});

test('slash command menu is limited to tmux-backed agent sessions', () => {
  assert.equal(slashCommandMenuAvailable({ provider: 'codex', tmuxSession: 'codeck' }), true);
  assert.equal(slashCommandMenuAvailable({ provider: 'claude', tmuxSession: 'claude-work' }), true);
  assert.equal(slashCommandMenuAvailable({ provider: 'qodercli', tmuxSession: 'qoder-work' }), true);
  assert.equal(slashCommandMenuAvailable({ provider: 'codex', tmuxSession: '' }), false);
  assert.equal(slashCommandMenuAvailable({ provider: 'shell', tmuxSession: 'shell-work' }), false);
});

test('slash command completion replaces only a partial command token', () => {
  assert.equal(completeSlashCommand('/sta', '/status'), '/status');
  assert.equal(completeSlashCommand('/', '/status'), '/status');
  assert.equal(completeSlashCommand('/status now', '/status'), '/status now');
  assert.equal(completeSlashCommand('hello', '/status'), 'hello');
});

test('slash command selection wraps in both directions', () => {
  assert.equal(nextSlashCommandIndex(0, 3, 1), 1);
  assert.equal(nextSlashCommandIndex(2, 3, 1), 0);
  assert.equal(nextSlashCommandIndex(0, 3, -1), 2);
  assert.equal(nextSlashCommandIndex(0, 0, 1), -1);
});

test('Tab and partial Enter complete while exact Enter remains available to send', () => {
  const suggestions = [{ command: '/status' }, { command: '/statusline' }];
  assert.deepEqual(slashCommandKeyAction({
    key: 'Tab', value: '/sta', suggestions, activeIndex: 0,
  }), { type: 'complete', command: '/status' });
  assert.deepEqual(slashCommandKeyAction({
    key: 'Enter', value: '/sta', suggestions, activeIndex: 0,
  }), { type: 'complete', command: '/status' });
  assert.equal(slashCommandKeyAction({
    key: 'Enter', value: '/status', suggestions, activeIndex: 0,
  }), null);
  assert.deepEqual(slashCommandKeyAction({
    key: 'Escape', value: '/sta', suggestions, activeIndex: 0,
  }), { type: 'close' });
});
