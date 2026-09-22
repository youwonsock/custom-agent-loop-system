const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture } = require('./webview-fixture.cjs');
const script = fs.readFileSync(path.join(__dirname, '../media/webview.js'), 'utf8');
function mount(t, payload = fixture()) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, messages = [];
  window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) });
  window.eval(script);
  const message = data => window.dispatchEvent(new window.MessageEvent('message', { data: structuredClone(data) }));
  const update = payload => message({ command: 'stateUpdate', payload });
  update(payload);
  const query = selector => window.document.querySelector(selector);
  const input = (selector, value, type = 'input') => { const el = query(selector); assert.ok(el, selector); el.value = value; el.dispatchEvent(new window.Event(type, { bubbles: true })); return el; };
  return { window, messages, message, update, query, input };
}

test('initialized empty registry offers a working new-session composer', t => {
  const ui = mount(t, fixture(null));
  assert.ok(ui.query('#composer-goal'));
  assert.equal(ui.query('#composer-start').disabled, false);
});

test('start sends visible role defaults and preserves the goal until successful acknowledgement', t => {
  const payload = fixture(null);
  Object.assign(payload.systemSettings.pipeline.roles[0], { provider: 'codex', model: 'model-B', variant: 'high' });
  const ui = mount(t, payload);
  ui.input('#composer-goal', 'Keep every condition on a launch failure.');
  ui.query('#composer-start').click();
  const sent = ui.messages.find(m => m.command === 'newSession');
  assert.equal(sent.modelMapping.planner, 'model-B');
  assert.equal(sent.variantMapping.planner, 'high');
  assert.equal(ui.query('#composer-start').disabled, true);
  assert.equal(ui.query('#composer-goal').value, 'Keep every condition on a launch failure.');
  ui.message({ command: 'newSessionResult', requestId: 'stale', sessionId: 'wrong' });
  assert.equal(ui.query('#composer-start').disabled, true);
  ui.message({ command: 'newSessionResult', requestId: sent.requestId, error: 'CLI executable was not found' });
  assert.equal(ui.query('#composer-goal').value, sent.goal);
  assert.equal(ui.query('#composer-start').disabled, false);
  assert.match(ui.query('.form-error').textContent, /CLI executable/);
  ui.query('#composer-start').click();
  const retry = ui.messages.filter(m => m.command === 'newSession').at(-1);
  ui.message({ command: 'newSessionResult', requestId: retry.requestId, sessionId: 'new' });
  ui.message({ command: 'focusComposer' });
  assert.equal(ui.query('#composer-goal').value, '');
});

test('polling does not replace a focused input after the old three-second deadline', async t => {
  const ui = mount(t, fixture(null));
  const input = ui.input('#composer-goal', 'Editing a long goal');
  input.focus(); input.setSelectionRange(4, 9);
  const next = fixture(null); next.progressNotes = 'new background status';
  ui.update(next);
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal(ui.query('#composer-goal'), input);
  assert.equal(ui.window.document.activeElement, input);
  assert.equal(input.selectionStart, 4);
});

test('logs and restored snapshots belong only to the selected session', t => {
  const ui = mount(t);
  ui.message({ command: 'logAppend', sessionId: 'session-A', entry: { text: 'A log' } });
  ui.message({ command: 'logAppend', sessionId: 'session-B', entry: { text: 'B log' } });
  assert.equal(ui.query('.log-content').textContent, 'A log');
  ui.update(fixture('session-B'));
  assert.equal(ui.query('.log-content').textContent, 'B log');
  const payload = fixture(); payload.sessionLog = 'Recovered A snapshot'; ui.update(payload);
  assert.equal(ui.query('.log-content').textContent, 'Recovered A snapshot');
});

test('reading older log lines does not force scroll on append', t => {
  const ui = mount(t), log = ui.query('.log-content');
  Object.defineProperties(log, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  log.scrollTop = 40;
  ui.message({ command: 'logAppend', sessionId: 'session-A', entry: { text: 'new output' } });
  assert.equal(log.scrollTop, 40);
});

test('saved models remain visible and read-only even if their provider is unavailable', t => {
  const payload = fixture('session-A', 'PAUSED');
  payload.registry.providerCatalog.codex.available = false;
  payload.state.modelMapping.implementer = 'archived-custom-model';
  const ui = mount(t, payload);
  assert.equal(ui.query('select[data-role]'), null);
  assert.match(ui.query('.model-grid').textContent, /archived-custom-model/);
  assert.ok(ui.query('#btn-new-session'));
});

test('invalid MCP JSON is preserved across tabs and blocks save', t => {
  const ui = mount(t);
  ui.query('#btn-settings').click(); ui.query('[data-settings-tab="tools"]').click(); ui.query('#add-mcp').click();
  const selector = '[data-mcp="0"][data-setting-field="environment"]';
  ui.input(selector, '{"TOKEN":');
  ui.query('[data-settings-tab="models"]').click(); ui.query('#settings-save').click();
  assert.equal(ui.messages.some(m => m.command === 'saveSystemSettings'), false);
  ui.query('[data-settings-tab="tools"]').click(); assert.equal(ui.query(selector).value, '{"TOKEN":');
  ui.input(selector, '{"TOKEN":42}'); ui.query('#settings-save').click();
  assert.equal(ui.messages.some(m => m.command === 'saveSystemSettings'), false);
  ui.input(selector, '{"TOKEN":"${env:TEST_TOKEN}"}'); ui.query('#settings-save').click();
  assert.equal(ui.messages.find(m => m.command === 'saveSystemSettings').settings.toolAccess.mcpServers[0].environment.TOKEN, '${env:TEST_TOKEN}');
  assert.equal(ui.query('#settings-save').disabled, true);
  ui.message({ command: 'settingsSaveResult', error: 'Disk is full' });
  assert.equal(ui.query('#settings-save').disabled, false);
  assert.match(ui.query('#settings-error').textContent, /Disk is full/);
});

test('role and stage editing updates references and serializes the whole graph', t => {
  const ui = mount(t);
  ui.query('#btn-settings').click(); ui.query('[data-settings-tab="stages"]').click();
  ui.input('[data-role-setting="1"][data-setting-field="id"]', 'planner', 'change');
  assert.equal(ui.query('[data-role-setting="1"][data-setting-field="id"]').value, 'implementer');
  assert.match(ui.query('#settings-error').textContent, /Could not rename/);
  ui.input('[data-role-setting="1"][data-setting-field="id"]', 'builder', 'change');
  assert.equal(ui.query('[data-stage-setting="1"][data-setting-field="role"]').value, 'builder');
  ui.input('[data-stage-setting="1"][data-setting-field="id"]', 'BUILD', 'change');
  assert.equal(ui.query('[data-pipeline-root="reentryStageId"]').value, 'BUILD');
  ui.query('#add-role').click(); ui.query('#add-stage').click();
  ui.query('#settings-save').click();
  const saved = ui.messages.find(m => m.command === 'saveSystemSettings').settings.pipeline;
  assert.equal(saved.roles.length, 7); assert.equal(saved.stages.length, 7);
  assert.equal(saved.stages.find(s => s.id === 'PLANNING').onSuccess, 'BUILD');
  assert.equal(saved.stages.find(s => s.id === 'BUILD').role, 'builder');
});

test('plan approval button opens the selected session review', t => {
  const payload = fixture('session-A', 'WAITING_USER'); payload.state.awaitingPlanApproval = true;
  const ui = mount(t, payload); ui.query('#btn-plan-review').click();
  assert.deepEqual(ui.messages.at(-1), { command: 'openPlanReview', sessionId: 'session-A' });
});
