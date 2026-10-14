/**
 * Claude 每轮提醒改用轮内系统消息（turn-scoped mid-conversation system messages）。
 *
 * 官方依据（https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages，
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking）：
 * - 每轮提醒写成 `{"role":"system","clear_at":"next_user_message","content":"..."}`，追加在 tool_result（或 user）
 *   消息之后；之前发过的副本原样留在原位。之后出现 user 消息（只带 tool_result 的也算）时它被清除：
 *   仍在数组里，但不显示、不计 token，因此前缀不变，缓存继续命中，Opus 5.5 / Fable 5.1 的思考块也保持有效。
 * - “Re-send cleared messages verbatim”：重建、删除或改 clear_at 都等于改了更早的消息。
 * - 需要 beta 头 `mid-conversation-system-clear-at-2026-08-21`，否则 `messages.N.clear_at: Extra inputs are not permitted`。
 * - 位置：必须紧跟 user 轮，后面只能是 assistant 轮或数组结尾；不能是第一条；连续多条视为一段。
 *
 * 分工：内核只把提醒标成“本轮 / 历史”两种内容（带 `TurnReminderMarker`（见 turnReminderLayout.ts）），决定发送形态在这里：
 * - `claude_turn_scoped`：紧跟 user 内容的提醒编码为 Claude 专用的轮内系统消息（接入库 `Content.claudeSystemMessage`）；
 *   前一条不是 user 内容时（例如模型没有调用工具就停下、内核追加“未完成任务检查”），官方不允许放 system 消息，
 *   这条提醒按原来的尾巴形态作为 user 消息发出——之后的请求按同一规则在同一位置原样重发它，前缀仍然不变。
 *   带运行状态卡的提醒（标记里有 identitySplit）：运行状态卡含模型撰写的第三方文本，不提升为系统消息，先作为 user 消息发出，
 *   其余部分（任务卡、未完成任务检查）作为紧随其后的轮内系统消息；只有运行状态卡时整条按 user 消息发出。
 * - `tail`：原来的尾巴模式，历史提醒全部不发，本轮提醒作为最后一条 user 消息。开关关闭时内核根本不产生标记，
 *   这里原样返回同一个数组，请求逐字节不变；Claude 网关回退走这条路径。Responses 发出的 user 历史快照由公共布局原样保留。
 *   尾巴上的内容下一次请求就不在原位了，所以 Claude 的消息缓存断点放在尾巴之前（见 withClaudeCacheBreakpointBeforeVolatileTail）。
 *
 * 重新注入的当前 Turn 输入（压缩掉了本 Turn 输入时，内核把它作为易失尾巴放在提醒前面）同样是发过的历史：
 * - `claude_turn_scoped`：一次请求把它作为尾巴发出后，之后的请求把那份原文放回那次请求的模型输出前面（提醒之前），
 *   逐字节重现当时的前缀；同一窗口里它只出现这一次，之后请求的尾巴副本不再发送（标成 current 的 reinjected_input）。
 * - `tail`：历史副本不发，尾巴副本照常发送，与开关关闭时完全相同。
 */
import { isRecord } from './llmStreamEventProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

export const CLAUDE_TURN_SCOPED_SYSTEM_BETA = 'mid-conversation-system-clear-at-2026-08-21';

export function isTurnScopedSystemMessage(message: unknown): boolean {
  return isRecord(message) && message.role === 'system' && message.clear_at === 'next_user_message';
}

function bodyHasTurnScopedSystemMessages(body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.messages) && body.messages.some(isTurnScopedSystemMessage);
}

/**
 * 编码后的最后一步：本请求使用轮内系统消息模式（或请求体里确实有 clear_at 消息）时，把 beta 头合并进
 * `anthropic-beta`。已有值（用户自定义头、压缩或保留思考自动加的 beta）保留，逗号合并并去重。
 */
export function withClaudeTurnScopedSystemBeta(
  request: EncodedProviderRequest,
  active: boolean
): EncodedProviderRequest {
  if (!active && !bodyHasTurnScopedSystemMessages(request.body)) return request;
  const headers = withAnthropicBetaValue(request.headers, CLAUDE_TURN_SCOPED_SYSTEM_BETA);
  return headers === request.headers ? request : { ...request, headers };
}

/**
 * 尾巴模式（开关关闭，或网关拒绝后退回）下，本轮提醒与重新注入的输入是易失尾巴：下一次请求不会在同一位置再发它们。
 * 接入库把消息断点放在最后一条 user 消息上，正好落在易失尾巴上；这个位置的缓存只写不读，
 * 每一轮都按 1.25 倍价格重写整段历史，历史部分永远命中不了。
 * 官方（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）：缓存按前缀匹配，易变内容要放在最后一个
 * 断点之后；断点前面的前缀在下一次请求里原样出现，才能从之前写入的位置读到。
 * 这里把消息断点挪到易失尾巴之前最近一条能打断点的消息上（同一个 cache_control，断点数不变）：
 * user 消息打在最后一块；续写场景 `[U, M, 提醒]` 里是模型输出 M，打在它最后一个非思考块上
 * （思考块不能带 cache_control），M 也进缓存。挪动、增删 cache_control 不改变前缀，也不影响已有思考块的有效性。
 * `volatileTailCount` 是内容末尾的易失条数（每条内容编码为一条 user 消息）；形状对不上、尾巴上没有断点、
 * 尾巴前面没有能打断点的消息时原样返回同一引用。
 */
export function withClaudeCacheBreakpointBeforeVolatileTail(
  request: EncodedProviderRequest,
  volatileTailCount: number
): EncodedProviderRequest {
  const body = request.body;
  if (!Number.isSafeInteger(volatileTailCount) || volatileTailCount <= 0) return request;
  if (!isRecord(body) || !Array.isArray(body.messages)) return request;
  const messages = body.messages as unknown[];
  const tailStart = messages.length - volatileTailCount;
  if (tailStart <= 0) return request;
  const tail = messages.slice(tailStart);
  if (!tail.every((message) => isRecord(message) && message.role === 'user')) return request;
  let cacheControl: unknown;
  const strippedTail = tail.map((message) => {
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content) || !record.content.some((block) => isRecord(block) && 'cache_control' in block)) {
      return message;
    }
    return {
      ...record,
      content: record.content.map((block) => {
        if (!isRecord(block) || !('cache_control' in block)) return block;
        cacheControl ??= block.cache_control;
        const { cache_control: _moved, ...rest } = block;
        return rest;
      })
    };
  });
  if (cacheControl === undefined) return request;
  let target = -1;
  let targetBlock = -1;
  for (let index = tailStart - 1; index >= 0 && target < 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (typeof message.content === 'string') {
      if (message.content) {
        target = index;
        targetBlock = 0;
      }
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    // user 消息打在最后一块上；模型输出跳过末尾的思考块。形状不对的块不动。
    for (let block = message.content.length - 1; block >= 0; block -= 1) {
      const candidate = message.content[block];
      if (!isRecord(candidate)) break;
      if (message.role === 'assistant' && (candidate.type === 'thinking' || candidate.type === 'redacted_thinking')) continue;
      target = index;
      targetBlock = block;
      break;
    }
  }
  if (target < 0) return request;
  const targetMessage = messages[target] as Record<string, unknown>;
  const blocks = typeof targetMessage.content === 'string'
    ? [{ type: 'text', text: targetMessage.content }]
    : targetMessage.content as Record<string, unknown>[];
  const markedBlocks = blocks.map((block, index) => index === targetBlock ? { ...block, cache_control: cacheControl } : block);
  const next = [...messages.slice(0, tailStart), ...strippedTail];
  next[target] = { ...targetMessage, content: markedBlocks };
  return { ...request, body: { ...body, messages: next } };
}

export function withAnthropicBetaValue(headers: Record<string, string>, beta: string): Record<string, string> {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta');
  const values = (existingKey ? headers[existingKey] : '').split(',').map((value) => value.trim()).filter(Boolean);
  const merged = [...new Set([...values, beta])].join(',');
  if (existingKey === 'anthropic-beta' && headers[existingKey] === merged) return headers;
  const next = { ...headers };
  if (existingKey) delete next[existingKey];
  next['anthropic-beta'] = merged;
  return next;
}

/**
 * 网关明确拒绝轮内系统消息的 400/422 文本。只在本请求确实用了轮内系统消息时才拿来判断（见 providerParameterAdaptation）。
 * - 官方原文（没有 beta 头时）：`messages.3.clear_at: Extra inputs are not permitted`；其他明确点名 clear_at 字段的拒绝。
 * - 官方轮内系统消息的其他校验原文都含 “turn-scoped system message”。
 * - 不支持 system 角色消息：旧版 Messages API 的 `Unexpected role "system". The Messages API accepts a top-level
 *   \`system\` parameter, not "system" as an input message role.`，以及 pydantic 风格
 *   `messages.3.role: Input should be 'user' or 'assistant'`。
 * - 位置不合法：提到 system 消息且说明必须/不能出现在某个位置的错误。
 * - beta 头这一层的拒绝（https://platform.claude.com/docs/en/api/beta-headers “Error handling”，beta 不存在或组织没开通）：
 *   ``Unexpected value(s) `mid-conversation-system-clear-at-2026-08-21` for the `anthropic-beta` header.``；
 *   开关打开时每个请求都带这个头，所以首轮、没有提醒的请求和原生压缩也会收到它。只认点名本 beta 的，别的 beta 被拒不算。
 */
const TURN_SCOPED_REJECTIONS: readonly RegExp[] = [
  /(?<![\w])clear_at['"`]?\s*:?\s*extra inputs are not permitted/i,
  /['"`]clear_at['"`][^\n]{0,80}(?:extra_forbidden|not permitted|unknown|unrecognized|unsupported|not allowed)/i,
  /(?:unknown|unrecognized|unsupported|unexpected)\s+(?:field|parameter|property|key|argument)s?[^\n]{0,40}clear_at/i,
  /turn-scoped system message/i,
  /unexpected role\W{1,3}system/i,
  /messages\.\d+\.role\W[^\n]{0,40}(?:input should be|must be one of|expected)[^\n]{0,40}user[^\n]{0,20}assistant/i,
  /(?:role\W{1,3}system\W|system role|system messages?\b)[^\n]{0,60}not (?:supported|allowed|permitted)/i,
  /system messages?\b[^\n]{0,120}(?:must|cannot|can't|can not|may not|may only|only allowed)[^\n]{0,120}(?:follow|after|before|precede|first|position|placed|immediately)/i,
  /unexpected value\(s\)[^\n]{0,300}?mid-conversation-system-clear-at-/i
];

export function claudeTurnScopedRemindersRejected(errorText: string): boolean {
  return TURN_SCOPED_REJECTIONS.some((pattern) => pattern.test(errorText));
}
