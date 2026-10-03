import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composerControlState } from '../public/remote-composer.js';

const source = fs.readFileSync(new URL('../public/remote.js', import.meta.url), 'utf8');
const expression = source.match(/const controls = (composerControlState\(\{[\s\S]*?\}\));/)[1];
test('Remote stop visibility follows execution, not support for autonomous mode', () => {
  for (const provider of ['codex', 'claude', 'qodercli', 'shell']) {
    for (const autonomySupported of [false, true]) {
      const context = { composerControlState, state: { provider, autonomySupported, connected: true, scopedSessionStop: true },
        sessionName: 'work', active: true, background: false, hasContent: false, opening: false, closing: false, pending: false, readOnly: false };
      const render = () => vm.runInNewContext(expression, context);
      assert.equal(render().stopMode, true, `${provider}, autonomySupported=${autonomySupported}`);
      assert.equal(render().disabled, false);
      context.active = false; context.background = true;
      assert.equal(render().stopMode, true);
      context.hasContent = true;
      assert.equal(render().stopMode, false, 'drafts still send instead of interrupting');
      context.hasContent = false; context.pending = true;
      assert.equal(render().disabled, true, 'in-flight requests remain guarded');
      context.pending = false; context.background = false;
      assert.equal(render().stopMode, false);
    }
  }
});
