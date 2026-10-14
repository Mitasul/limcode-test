import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { ModelProviderControlPlane } = load('backend/reliableKernel/modelProviderControlPlane.js');
const { projectTurnReminder, requestTurnReminderDelivery } = load('backend/reliableKernel/turnReminderProjection.js');

const responses = { model: { provider: 'openai-responses' } };
const ordinary = { kind: 'reliable-agent-turn', turnReminderDelivery: 'user_history' };
const source = (segmentId, recipeId, segmentKind = 'message') => ({
  segmentId, segmentKind, messageRole: segmentKind === 'message' ? 'model' : null,
  sourceRecipeObjectId: recipeId
});

function fixture(objects) {
  const bodies = new Map(Object.entries(objects).map(([id, value]) => [id, Buffer.from(JSON.stringify(value))]));
  const reads = [];
  const metadata = id => ({ id, content_type: 'application/json', byte_length: BigInt(bodies.get(id).length) });
  const database = { async snapshot(commands) {
    return { snapshot: commands.map(command => metadata(command.id)) };
  } };
  const store = { async readMany(items) {
    reads.push(...items.map(item => item.id));
    return items.map(item => bodies.get(item.id));
  } };
  return { plane: new ModelProviderControlPlane(database, store), reads };
}

test('Responses 新请求冻结 user 历史语义，快照文字在重放时不变，旧 recipe 保留原文', () => {
  assert.equal(requestTurnReminderDelivery(responses), 'user_history');
  assert.equal(requestTurnReminderDelivery({ model: { provider: 'claude', claudeTurnScopedReminders: true } }), 'claude_turn_scoped');
  assert.equal(requestTurnReminderDelivery({ model: { provider: 'claude' } }), undefined);
  const card = { kind: 'reliable-agent-turn', runtimeStatusCard: { card: 'runningProcesses=1' } };
  assert.equal(projectTurnReminder(card).content, 'runningProcesses=1');
  const frozen = { ...card, turnReminderDelivery: 'user_history' };
  const content = projectTurnReminder(frozen).content;
  assert.match(content, /before the assistant response immediately following this message/);
  assert.match(content, /historical evidence/);
  assert.equal(projectTurnReminder(JSON.parse(JSON.stringify(frozen))).content, content);
});

test('历史提醒在同一 recipe 的首个真实输出前只放一次，分支选择和跨模型读取复用冻结事实', async () => {
  const { plane, reads } = fixture({
    first: { ...ordinary, runtimeStatusCard: { card: 'runningProcesses=1' } },
    second: { ...ordinary, runtimeStatusCard: { card: 'runningProcesses=0' } },
    legacy: { kind: 'reliable-agent-turn', runtimeStatusCard: { card: 'legacy' } }
  });
  const history = [source('call-a', 'first', 'tool_pair'), source('text-a', 'first'),
    source('text-b', 'second'), source('old', 'legacy')];
  const entries = await plane.materializeTurnReminderHistory(responses, ordinary, history);
  assert.deepEqual(entries.map(entry => [entry.segmentId, entry.delivery]), [
    ['call-a', 'user_history'], ['text-b', 'user_history']
  ]);
  assert.match(entries[0].content, /runningProcesses=1$/);
  assert.match(entries[1].content, /runningProcesses=0$/);
  assert.deepEqual(reads, ['first', 'second', 'legacy']);
  const fork = await plane.materializeTurnReminderHistory({ model: { provider: 'claude' } }, ordinary,
    [source('fork-a', 'first', 'tool_pair')]);
  assert.deepEqual(fork.map(entry => entry.segmentId), ['fork-a']);
  assert.equal(fork[0].content, entries[0].content);
  assert.deepEqual(reads, ['first', 'second', 'legacy']);
});

test('重注入输入随首个发送位置保留一次，原生压缩保留历史，文本摘要不重复引入状态快照', async () => {
  const input = { messageRevisionId: 'input-revision', contentObjectId: 'input', reinject: true };
  const { plane } = fixture({
    first: { ...ordinary, currentTurnInput: input, attachmentCatalogState: { catalog: [], placements: [] } },
    second: { ...ordinary, currentTurnInput: input, attachmentCatalogState: { catalog: [], placements: [] },
      runtimeStatusCard: { card: 'latest' } },
    input: { role: 'user', parts: [{ text: 'original task' }] }
  });
  const history = [source('first-output', 'first'), source('second-output', 'second')];
  const compact = { kind: 'reliable-context-compression', compressionMethodKind: 'provider_native' };
  const entries = await plane.materializeTurnReminderHistory(responses, compact, history);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].reinjectedInput.messageRevisionId, 'input-revision');
  assert.equal(entries[1].reinjectedInput, undefined);
  assert.match(entries[1].content, /latest$/);
  assert.equal(await plane.materializeTurnReminderHistory(responses,
    { ...compact, compressionMethodKind: 'llm_summary' }, history), undefined);
  assert.equal(await plane.materializeTurnReminderHistory(responses,
    { ...compact, sourceReplay: 'immutable_provenance' }, history), undefined);
});
