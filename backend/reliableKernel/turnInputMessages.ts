import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Input order is the durable Conversation message order, never link ids or timestamps. */
export async function readOrderedTurnInputMessages(
  database: RuntimeDatabase,
  turnId: string
): Promise<Array<{ link: DomainRow; membership: DomainRow }>> {
  const links = await listAllDomainRows(database, 'MessageTurnLink', { turn_id: turnId, role: 'input' });
  if (links.length === 0) return [];
  const { snapshot } = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
    ...links.map(link => DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
      where: { message_id: link.message_id }, limit: 2
    }))
  ]);
  const turn = snapshot[0];
  if (!turn || Array.isArray(turn)) throw new Error(`Input Turn ${turnId} is missing.`);
  return links.map((link, index) => {
    const memberships = snapshot[index + 1];
    if (!Array.isArray(memberships) || memberships.length !== 1
      || memberships[0].conversation_id !== turn.conversation_id) {
      throw new Error(`Turn ${turnId} input Message conflicts with its Conversation membership.`);
    }
    return { link, membership: memberships[0] };
  }).sort((left, right) => {
    const a = BigInt(left.membership.message_seq as string);
    const b = BigInt(right.membership.message_seq as string);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
