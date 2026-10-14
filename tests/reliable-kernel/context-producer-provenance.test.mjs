import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createBatchFixture, load, repo, NOW } from './fixtures/runtime-behavior-fixture.mjs';
import { modelRequestAggregate } from './fixtures/runtime-merge-fixture.mjs';

const { ContextSequenceControlPlane } = load('backend/reliableKernel/contextSequence.js');
const { nativeItemRevisionId } = load('backend/reliableKernel/turnOutput.js');
const { modelRequestIdFor } = load('backend/reliableKernel/modelProviderControlPlane.js');
const { conversationForkSnapshotCopyId } = load('backend/reliableKernel/conversationForkSnapshot.js');
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
let fixture, context;
before(async () => {
  fixture = await createBatchFixture();
  context = new ContextSequenceControlPlane(fixture.database, fixture.store);
});
after(async () => { await fixture?.close(); });

async function producer(label, options = {}) {
  const conversationId = `${label}-conversation`, turnId = `${label}-turn`;
  const requestId = options.requestId ?? `${label}-request`;
  const authorityId = `${label}-authority`;
  const recipe = await fixture.store.ingest(fixture.database, JSON.stringify({
    kind: 'reliable-agent-turn', round: '1', nativeResponses: options.nativeResponses ?? true,
    taskStateReminder: `frozen reminder for ${label}`
  }), 'application/json');
  const authority = await fixture.store.ingest(fixture.database, JSON.stringify({
    kind: 'effective-turn-authority', turnId: options.originalTurnId ?? turnId
  }), 'application/json');
  const body = await fixture.store.ingest(fixture.database, JSON.stringify({
    role: 'model', parts: [{ text: 'completed' }]
  }), MESSAGE_TYPE);
  const aggregate = modelRequestAggregate(turnId, requestId, 1n, {
    recipe: recipe.id, body: body.id, checkpoints: 1
  });
  aggregate.find(step => step.domain === 'ModelRequest').row.authority_snapshot_id = authorityId;
  await fixture.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: label, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated',
      created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: `${label}-termination`, turn_id: turnId,
      terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    repo('AuthoritySnapshot').insert({ id: authorityId, turn_id: turnId, content_object_id: authority.id, created_at: NOW }),
    ...aggregate
  ]);
  return { label, conversationId, turnId, requestId, recipeId: recipe.id, bodyId: body.id,
    authorityId, authorityContentId: authority.id };
}

async function message(p, { revisionId = `${p.label}-revision`, revision = 1n, bodyId = p.bodyId } = {}) {
  const messageId = `${p.label}-message`;
  await fixture.database.transaction([
    repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: revisionId, message_id: messageId, revision_seq: revision,
      role: 'model', content_object_id: bodyId, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: `${p.label}-current`, message_id: messageId,
      revision_id: revisionId, updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: `${p.label}-member`, conversation_id: p.conversationId,
      message_id: messageId, message_seq: 1n, created_at: NOW }),
    repo('ModelRequestMessageLink').insert({ id: `${p.label}-output`, model_request_id: p.requestId,
      message_id: messageId, created_at: NOW })
  ]);
  return { messageId, revisionId, revision, bodyId };
}

async function segment(p, kind, bodyId, sourceKind, sourceId, sourceRevision, additionalSources = []) {
  const segmentId = `${p.label}-segment`, nodeId = `${p.label}-node`, rootId = `${p.label}-root`;
  await fixture.database.transaction([
    repo('ContextSegment').insert({ id: segmentId, content_object_id: bodyId, segment_kind: kind, created_at: NOW }),
    repo('ContextSegmentSource').insert({ id: `${p.label}-source`, segment_id: segmentId,
      source_kind: sourceKind, source_id: sourceId, source_revision: sourceRevision, created_at: NOW }),
    ...additionalSources.map((source, index) => repo('ContextSegmentSource').insert({
      id: `${p.label}-source-${index}`, segment_id: segmentId, ...source, created_at: NOW
    })),
    repo('ContextSequenceNode').insert({ id: nodeId, parent_node_id: null, segment_id: segmentId, created_at: NOW }),
    repo('ContextSequenceRoot').insert({ id: rootId, conversation_id: p.conversationId, root_seq: 1n,
      root_node_id: nodeId, tail_node_id: null, tail_segment_count: 0n,
      segment_count: 1n, estimated_tokens: 1n, created_at: NOW })
  ]);
  const cacheBefore = (await fixture.database.inspect()).contextCasCache;
  const structure = await context.materializeStructure(rootId);
  assert.deepEqual((await fixture.database.inspect()).contextCasCache, cacheBefore,
    'structural materialization must not read CAS bytes to determine native provenance');
  const content = await context.materialize(rootId);
  const cacheAfter = (await fixture.database.inspect()).contextCasCache;
  return { structure: structure.records[0], content: content.segments[0], cacheBefore, cacheAfter };
}

function assertProducer(records, p) {
  assert.equal(records.content.sourceModelRequestId, p.requestId);
  assert.equal(records.content.sourceRecipeObjectId, p.recipeId);
  assert.deepEqual(records.content.sourceReminderAuthority, { modelRequestId: p.requestId,
    authoritySnapshotId: p.authorityId, contentObjectId: p.authorityContentId });
}

function assertNoProducer(record) {
  assert.equal(record.sourceModelRequestId, undefined);
  assert.equal(record.sourceRecipeObjectId, undefined);
  assert.equal(record.sourceReminderAuthority, undefined);
}

async function nativeBody(responseId) {
  return fixture.store.ingest(fixture.database, JSON.stringify({ role: 'model', parts: [{
    text: 'native response item', outputItem: { id: 'native-item', ordinal: 2, providerResponseId: responseId }
  }] }), MESSAGE_TYPE);
}

async function toolCall(p) {
  const output = await message(p);
  const toolCallId = `${p.label}-tool`;
  const args = await fixture.store.ingest(fixture.database, '{}', 'application/json');
  const pair = await fixture.store.ingest(fixture.database, JSON.stringify({
    call: { name: 'read', args: {} }, outputItem: { id: 'native-call', ordinal: 0, providerResponseId: 'response-tool' }
  }), 'application/vnd.limcode.context-tool-pair+json');
  await fixture.database.transaction([
    repo('ToolCall').insert({ id: toolCallId, turn_id: p.turnId, call_seq: 1n, tool_name: 'read',
      status: 'terminal', arguments_object_id: args.id, created_at: NOW, updated_at: NOW }),
    repo('ToolCallSourceLink').insert({ id: `${p.label}-tool-source`, tool_call_id: toolCallId,
      model_request_id: p.requestId, message_id: output.messageId, provider_call_id: 'native-call',
      provider_ordinal: 0n, batch_id: `${p.label}-batch`, batch_ordinal: 0n,
      thought_signature: null, created_at: NOW })
  ]);
  return { toolCallId, pair };
}

test('a native tool-only context retains its request recipe without an assistant message segment', async () => {
  const p = await producer('tool-only');
  const { toolCallId, pair } = await toolCall(p);
  const records = await segment(p, 'tool_pair', pair.id, 'tool_call', toolCallId, 1n);
  assert.equal(records.content.messageRole, null);
  assertProducer(records, p);
});

test('an atomic tool result pair does not replay its assistant request reminder before the result', async () => {
  const p = await producer('atomic-pair', { nativeResponses: false });
  const { toolCallId } = await toolCall(p);
  const body = await fixture.store.ingest(fixture.database, JSON.stringify({
    role: 'tool', parts: [{ text: 'read result' }]
  }), MESSAGE_TYPE);
  const pair = await fixture.store.ingest(fixture.database, JSON.stringify({
    call: { name: 'read', args: {} }, result: { output: 'read result' }
  }), 'application/vnd.limcode.context-tool-pair+json');
  const messageId = `${p.label}-result-message`, revisionId = `${p.label}-result-revision`;
  const resultId = `${p.label}-result`;
  await fixture.database.transaction([
    repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: revisionId, message_id: messageId, revision_seq: 1n,
      role: 'tool', content_object_id: body.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: `${p.label}-result-current`, message_id: messageId,
      revision_id: revisionId, updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: `${p.label}-result-member`, conversation_id: p.conversationId,
      message_id: messageId, message_seq: 2n, created_at: NOW }),
    repo('ToolModelResult').insert({ id: resultId, tool_call_id: toolCallId,
      message_revision_id: revisionId, created_at: NOW })
  ]);
  const records = await segment(p, 'tool_pair', pair.id, 'tool_call', toolCallId, 1n, [{
    source_kind: 'tool_model_result', source_id: resultId, source_revision: 1n
  }]);
  assertNoProducer(records.content);
  assertNoProducer(records.structure);
});

test('a later immutable native item retains its producing request', async () => {
  const p = await producer('native-item');
  const body = await nativeBody('response-later');
  const revisionId = nativeItemRevisionId(p.turnId, p.requestId, 'content:response-later:2');
  await message(p, { revisionId, revision: 3n, bodyId: body.id });
  const records = await segment(p, 'message', body.id, 'message_revision', revisionId, 3n);
  assertProducer(records, p);
  assertNoProducer(records.structure);
  assert.equal(records.cacheAfter.misses - records.cacheBefore.misses, 1);
  assert.equal(records.cacheAfter.hits - records.cacheBefore.hits, 0,
    'native provenance and content transfer must share the same materialized bytes');
});

test('an edited assistant revision cannot reuse producer reminders merely by retaining outputItem', async () => {
  const p = await producer('edited-item');
  const body = await nativeBody('response-edited');
  const revisionId = 'user-edited-revision';
  await message(p, { revisionId, revision: 3n, bodyId: body.id });
  const records = await segment(p, 'message', body.id, 'message_revision', revisionId, 3n);
  assertNoProducer(records.content);
  assertNoProducer(records.structure);
});

test('a deep fork retains native provenance after its source and intermediate conversations are deleted', async () => {
  const originalTurnId = 'source-native-turn';
  const originalRequestId = modelRequestIdFor(originalTurnId, `agent-loop:${originalTurnId}:round:1`);
  const firstForkId = 'deleted-first-fork-conversation';
  const intermediateId = 'deleted-intermediate-conversation', targetId = 'forked-native-conversation';
  const requestId = conversationForkSnapshotCopyId(targetId, 'model_request',
    conversationForkSnapshotCopyId(intermediateId, 'model_request',
      conversationForkSnapshotCopyId(firstForkId, 'model_request', originalRequestId)));
  const p = await producer('forked-native', { requestId, originalTurnId });
  const originalRevisionId = nativeItemRevisionId(originalTurnId, originalRequestId, 'content:response-fork:2');
  const revisionId = conversationForkSnapshotCopyId(targetId, 'message_revision',
    conversationForkSnapshotCopyId(intermediateId, 'message_revision',
      conversationForkSnapshotCopyId(firstForkId, 'message_revision', originalRevisionId)));
  const body = await nativeBody('response-fork');
  await fixture.database.transaction([repo('ConversationBranchLink').insert({ id: 'native-copy-branch',
    target_conversation_id: targetId, source_conversation_id: intermediateId,
    source_message_revision_id: null, created_at: NOW })]);
  await message(p, { revisionId, revision: 3n, bodyId: body.id });
  const records = await segment(p, 'message', body.id, 'message_revision', revisionId, 3n, [{
    source_kind: 'message_revision', source_id: originalRevisionId, source_revision: 3n
  }]);
  assertProducer(records, p);
  assertNoProducer(records.structure);
});
