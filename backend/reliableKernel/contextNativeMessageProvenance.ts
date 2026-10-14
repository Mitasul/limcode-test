import { modelRequestIdFor } from './modelProviderControlPlane';
import { nativeItemRevisionId } from './turnOutput';

/** Only the immutable per-item output shape can prove a later native Message revision. */
export function nativeMessageRevisionItemKey(content: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return undefined; }
  const parts = record(value)?.parts;
  const item = Array.isArray(parts) && parts.length === 1 ? record(record(parts[0])?.outputItem) : undefined;
  return item && typeof item.providerResponseId === 'string' && Number.isSafeInteger(item.ordinal)
    ? `content:${item.providerResponseId}:${String(item.ordinal)}` : undefined;
}

/** Fork copies keep the original selector on their shared immutable ContextSegment. */
export function originalNativeMessageRevisionId(turnId: string, round: string, itemKey: string): string {
  const requestId = modelRequestIdFor(turnId, `agent-loop:${turnId}:round:${round}`);
  return nativeItemRevisionId(turnId, requestId, itemKey);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
