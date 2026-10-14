import { isCrossConversationSend } from './collaborationScope';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * Whether a collaboration delivery that finds no running Turn able to take it in opens a Turn of
 * its target:
 * - `opens_turn`: a followup task, a team message, or a completion/failure reply (team or
 *   cross-conversation). One idle period opens one Turn, which takes in everything pending, and
 *   every Turn an automatic wake opens spends the automatic followup budget.
 * - `never`: board notices and cross-conversation plain messages wait for the target's next Turn.
 */
export type CollaborationWakePolicy = 'opens_turn' | 'never';

export function collaborationWakePolicy(input: {
  mode: 'message' | 'followup';
  sourceKind: string;
  crossConversation: boolean;
}): CollaborationWakePolicy {
  if (input.mode === 'followup') return 'opens_turn';
  if (input.sourceKind === 'board') return 'never';
  if (input.sourceKind === 'tool' && input.crossConversation) return 'never';
  return 'opens_turn';
}

/** The wake policy of a committed collaboration message, read from its immutable facts. */
export async function collaborationMessageWakePolicy(
  database: RuntimeDatabase,
  messageId: string
): Promise<CollaborationWakePolicy> {
  const read = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('CollaborationMessage').get(messageId),
    DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').list({ where: { message_id: messageId }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').list({ where: { message_id: messageId }, limit: 2 })
  ]);
  const message = read.snapshot[0] as DomainRow | null;
  const sources = read.snapshot[1] as DomainRow[];
  const targets = read.snapshot[2] as DomainRow[];
  if (!message || sources.length !== 1 || targets.length !== 1) throw new Error(`Collaboration message ${messageId} has incomplete facts.`);
  const mode = message.mode === 'followup' ? 'followup' : 'message';
  return collaborationWakePolicy({
    mode,
    sourceKind: String(sources[0].source_kind),
    crossConversation: sources[0].source_kind === 'tool' && await isCrossConversationSend(database, messageId, mode)
  });
}
