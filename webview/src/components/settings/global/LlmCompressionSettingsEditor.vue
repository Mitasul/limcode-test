<script setup lang="ts">
import { computed } from 'vue';
import {
  createDefaultLlmCompressionConfig,
  DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS,
  DEFAULT_LLM_COMPRESSION_MAX_DURATION_MINUTES,
  DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
  MAX_LLM_COMPRESSION_DURATION_MINUTES,
  MIN_LLM_COMPRESSION_BODY_TARGET_TOKENS,
  normalizeLlmCompressionBodyTargetTokens,
  normalizeLlmCompressionMaxDurationMinutes,
  type LlmCompressionConfigRecord,
  type LlmCompressionFallbackKind,
  type LlmCompressionMethodKind,
  type LlmGenerationConfigRecord,
  type LlmNativeCompactionTrustMode,
  type LlmProviderConfigRecord,
  type LlmProviderKind,
  type LlmSummaryReasoningMode
} from '@shared/protocol';
import {
  capabilityDisplayLabel,
  resolveCompressionExecutionPlan,
  resolveProviderModelCapabilities,
  resolveSummaryReasoning
} from '@shared/modelCapabilities';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import LlmSettingHint from './parameters/LlmSettingHint.vue';
import LlmSummaryGenerationEditor from './LlmSummaryGenerationEditor.vue';
import TokenThresholdSlider from '@webview/components/ui/TokenThresholdSlider.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';

type SelectableCompressionMethodKind =
  | 'auto'
  | 'provider_native'
  | 'llm_summary'
  | 'segmented_summary'
  | 'deterministic_summary';

const TOKEN_STEP = 1_000;
const DEFAULT_FALLBACKS: readonly LlmCompressionFallbackKind[] = [
  'segmented_summary',
  'deterministic_summary',
  'continue_uncompressed_if_fits'
];
const FALLBACK_OPTIONS: readonly {
  value: LlmCompressionFallbackKind;
  label: string;
  description: string;
}[] = [
  {
    value: 'segmented_summary',
    label: '本地分段摘要',
    description: '在本地分段，再调用所选 LLM 渠道生成摘要；不是离线推理。'
  },
  {
    value: 'deterministic_summary',
    label: '确定性摘要',
    description: 'LLM 摘要仍失败时，使用本地确定性收口，避免再次调用 Provider。'
  },
  {
    value: 'continue_uncompressed_if_fits',
    label: '仍能放下时继续回答',
    description: '全部压缩方法失败后，仅在带安全余量的输入估算仍可容纳时继续一次。'
  }
];
const SUMMARY_REASONING_OPTIONS: SettingsDropdownOption[] = [
  {
    value: 'provider_default',
    label: '跟随 Provider 默认（推荐）',
    description: '不发送 reasoning/thinking 覆盖，避免跨厂商猜测档位。'
  },
  {
    value: 'economy',
    label: '经济',
    description: '仅在当前总结模型明确支持最低非关闭档时发送；DeepSeek、Kimi、智谱等按模型规则换成最接近的档位。'
  },
  {
    value: 'balanced',
    label: '平衡',
    description: '仅在当前总结模型明确支持 medium 时发送；DeepSeek、Kimi、智谱等按模型规则换成最接近的档位（例如 medium 发成 high）。'
  },
  {
    value: 'quality',
    label: '高质量',
    description: '仅在当前总结模型明确支持 high 时发送；DeepSeek、Kimi、智谱等按模型规则换成最接近的档位。'
  },
  {
    value: 'maximum',
    label: '最高质量',
    description: '使用能力快照中已确认的最高档。'
  },
  {
    value: 'inherit_chat',
    label: '继承聊天设置',
    description: '重新校验聊天模型的思考配置；不兼容时回到 Provider 默认。'
  },
  {
    value: 'disabled',
    label: '关闭思考',
    description: '只有当前总结模型明确允许关闭时才会发送。'
  },
  {
    value: 'explicit',
    label: '高级原生配置',
    description: '使用压缩配置中的 generationConfig；未知兼容端点会标记为未验证。'
  }
];

const props = defineProps<{
  config?: LlmCompressionConfigRecord;
  currentProviderConfig?: LlmProviderConfigRecord;
  providerConfigs: LlmProviderConfigRecord[];
  contextWindowTokens: number;
}>();

const emit = defineEmits<{
  (event: 'update-provider-config-id', value: string): void;
  (event: 'update-method-kind', value: SelectableCompressionMethodKind): void;
  (event: 'update-trigger', value: Partial<LlmCompressionConfigRecord['trigger']>): void;
  (event: 'update-max-duration-minutes', value: number): void;
  (event: 'update-body-target-tokens', value: number): void;
  (event: 'update-native-trust-mode', value: LlmNativeCompactionTrustMode): void;
  (event: 'update-summary-reasoning-mode', value: LlmSummaryReasoningMode): void;
  (event: 'update-summary-generation-config', value: LlmGenerationConfigRecord | undefined): void;
  (event: 'update-fallbacks', value: LlmCompressionFallbackKind[]): void;
  (event: 'verify-native', providerConfigId: string, modelId: string): void;
}>();

const providerOptions: SettingsDropdownOption[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
];

const selectedProviderSettings = computed(() => {
  const config = props.config;
  return (config?.kind === 'auto' || config?.kind === 'provider_native')
    && (config.providerNative?.providerConfigId?.trim() || config.providerNative?.model?.trim())
    ? config.providerNative : config?.llmSummary;
});
const providerConfigId = computed({
  get: () => selectedProviderSettings.value?.providerConfigId?.trim() || '__current__',
  set: (value: string) => emit('update-provider-config-id', value === '__current__' ? '' : value)
});

const providerConfig = computed(() => {
  const id = providerConfigId.value;
  return id === '__current__'
    ? props.currentProviderConfig
    : props.providerConfigs.find((config) => config.id === id) ?? props.currentProviderConfig;
});

const providerModelId = computed(() => selectedProviderSettings.value?.model?.trim()
  || providerConfig.value?.model?.trim()
  || '');

const nativeTrustMode = computed<LlmNativeCompactionTrustMode>(() =>
  props.config?.providerNative?.trustMode === 'trust_configured_endpoint'
    ? 'trust_configured_endpoint'
    : 'verified_only'
);

const capabilities = computed(() => {
  const provider = providerConfig.value;
  if (!provider) return undefined;
  const resolved = resolveProviderModelCapabilities(provider, providerModelId.value, nativeTrustMode.value);
  const chat = props.currentProviderConfig;
  if (chat && (provider.id !== chat.id || providerModelId.value !== chat.model)) {
    return { ...resolved, nativeCompaction: {
      availability: 'unsupported' as const,
      reason: '独立总结渠道或模型只能生成文本摘要；原生压缩状态必须由同一聊天渠道和模型消费。'
    } };
  }
  return resolved;
});

const nativeAvailable = computed(() => {
  const availability = capabilities.value?.nativeCompaction.availability;
  return availability === 'verified' || availability === 'declared';
});

const canDeclareNativeCapability = computed(() => {
  const provider = providerConfig.value?.provider;
  return capabilities.value?.nativeCompaction.availability !== 'verified'
    && (provider === 'openai-responses' || provider === 'claude');
});

const effectiveConfig = computed<LlmCompressionConfigRecord>(() => {
  const defaults = createDefaultLlmCompressionConfig('临时');
  const config = props.config ?? defaults;
  return {
    ...config,
    providerNative: {
      ...(config.providerNative ?? defaults.providerNative ?? {}),
      trustMode: nativeTrustMode.value
    },
    fallbacks: [...(config.fallbacks ?? defaults.fallbacks ?? DEFAULT_FALLBACKS)],
    llmSummary: {
      ...(defaults.llmSummary ?? {}),
      ...(config.llmSummary ?? {}),
      reasoning: {
        mode: config.llmSummary?.reasoning?.mode ?? 'provider_default'
      }
    }
  };
});

const executionPlan = computed(() => capabilities.value
  ? resolveCompressionExecutionPlan(effectiveConfig.value, capabilities.value)
  : undefined
);

const inheritedGenerationConfig = computed(() => {
  const inheritChat = props.config?.llmSummary?.reasoning?.mode === 'inherit_chat';
  const provider = inheritChat ? props.currentProviderConfig : providerConfig.value;
  if (!provider) return undefined;
  const modelId = inheritChat ? provider.model : providerModelId.value;
  return provider.modelConfigs.find((candidate) => candidate.modelId === modelId)?.generationConfig ?? provider.generationConfig;
});

const summaryReasoningMode = computed<LlmSummaryReasoningMode>(() =>
  props.config?.llmSummary?.reasoning?.mode ?? 'provider_default'
);

const summaryReasoningPlan = computed(() => capabilities.value
  ? resolveSummaryReasoning({
      mode: summaryReasoningMode.value,
      methodGenerationConfig: props.config?.llmSummary?.generationConfig,
      inheritedGenerationConfig: inheritedGenerationConfig.value,
      capabilities: capabilities.value
    })
  : undefined
);

const summaryReasoningOptions = computed<SettingsDropdownOption[]>(() => SUMMARY_REASONING_OPTIONS.map(option => {
  if (!capabilities.value || option.value === 'explicit' || option.value === 'inherit_chat') return option;
  const plan = resolveSummaryReasoning({ mode: option.value as LlmSummaryReasoningMode,
    methodGenerationConfig: props.config?.llmSummary?.generationConfig,
    inheritedGenerationConfig: inheritedGenerationConfig.value, capabilities: capabilities.value });
  return { ...option, disabled: plan.status === 'unsupported', description: plan.description };
}));

const providerConfigOptions = computed<SettingsDropdownOption[]>(() => [
  {
    value: '__current__',
    label: '跟随当前渠道',
    description: props.currentProviderConfig
      ? `${props.currentProviderConfig.name} · ${providerLabel(props.currentProviderConfig.provider)}`
      : '使用当前模型渠道'
  },
  ...props.providerConfigs.map((config) => ({
    value: config.id,
    label: config.name,
    description: config.model ? `${providerLabel(config.provider)} · ${config.model}` : providerLabel(config.provider)
  }))
]);

const activeMethodKind = computed<SelectableCompressionMethodKind>(() => {
  const kind = props.config?.kind ?? 'auto';
  if (kind === 'auto'
    || kind === 'provider_native'
    || kind === 'llm_summary'
    || kind === 'segmented_summary'
    || kind === 'deterministic_summary') return kind;
  return 'auto';
});

const methodOptions = computed<SettingsDropdownOption[]>(() => [
  {
    value: 'auto',
    label: '自动选择（推荐）',
    description: '已确认时使用 Provider 原生压缩，随后按冻结顺序回退到分段摘要和确定性摘要。'
  },
  {
    value: 'provider_native',
    label: 'Provider 原生压缩',
    description: nativeAvailable.value
      ? capabilities.value?.nativeCompaction.reason
      : `不可用：${capabilities.value?.nativeCompaction.reason ?? '尚未解析渠道能力。'}`,
    disabled: !nativeAvailable.value
  },
  {
    value: 'segmented_summary',
    label: '本地分段摘要',
    description: '按完整回合分块，再分层合并为 replacement summary。'
  },
  {
    value: 'llm_summary',
    label: '单次 LLM 摘要',
    description: '整段历史一次性交给总结模型，超大上下文不建议使用。'
  },
  {
    value: 'deterministic_summary',
    label: '确定性摘要',
    description: '不调用 Provider，使用本地确定性收口。'
  }
]);

const trigger = computed(() => props.config?.trigger);
const compressionAutoEnabled = computed(() => (trigger.value?.mode ?? 'token_threshold') === 'token_threshold');
const configuredThresholdPercent = computed(() => clampPercent(
  trigger.value?.thresholdPercent ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT
));
const compressionThresholdTokens = computed(() => {
  const contextWindow = props.contextWindowTokens;
  const tokenValue = trigger.value?.thresholdUnit === 'tokens'
    ? normalizeTokenCount(trigger.value.thresholdTokens)
    : undefined;
  if (tokenValue !== undefined) return clampTokenToContext(tokenValue, contextWindow);
  if (contextWindow <= 0) return 0;
  return clampTokenToContext((contextWindow * configuredThresholdPercent.value) / 100, contextWindow);
});
const compressionThresholdPercent = computed(() => {
  const contextWindow = props.contextWindowTokens;
  const thresholdTokens = compressionThresholdTokens.value;
  if (contextWindow > 0 && thresholdTokens > 0) return clampPercent((thresholdTokens / contextWindow) * 100);
  return configuredThresholdPercent.value;
});
const recommendedThresholdTokens = computed(() => {
  const contextWindow = props.contextWindowTokens;
  if (contextWindow <= 0) return 0;
  return clampTokenToContext(
    (contextWindow * DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT) / 100,
    contextWindow
  );
});
const compressionThresholdInputValue = computed(() => String(compressionThresholdTokens.value || ''));
const compressionBodyTargetMaxTokens = computed(() => (
  compressionAutoEnabled.value && compressionThresholdTokens.value > 0
    ? compressionThresholdTokens.value
    : props.contextWindowTokens
));
const compressionBodyTargetTokens = computed(() => clampBodyTargetTokens(
  normalizeLlmCompressionBodyTargetTokens(props.config?.bodyTargetTokens)
));
const recommendedBodyTargetTokens = computed(() => clampBodyTargetTokens(
  DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS
));
const compressionBodyTargetInputValue = computed(() => String(compressionBodyTargetTokens.value || ''));
const compressionMaxDurationMinutes = computed(() => normalizeLlmCompressionMaxDurationMinutes(props.config?.maxDurationMinutes));
const configuredFallbacks = computed<LlmCompressionFallbackKind[]>(() =>
  [...(props.config?.fallbacks ?? DEFAULT_FALLBACKS)]
);

const capabilitySourceLabel = computed(() => {
  const source = capabilities.value?.source;
  if (source === 'official_registry') return '按官方文档登记（不是在线测试）';
  if (source === 'provider_api') return 'Provider Models API';
  if (source === 'verified_probe') return '在线测试结果';
  if (source === 'explicit_trust') return '用户显式声明';
  return '未验证兼容端点';
});

const nativeCapabilityLabel = computed(() => capabilities.value
  ? capabilityDisplayLabel(capabilities.value)
  : '尚未解析'
);

const executionPlanLabel = computed(() => {
  const plan = executionPlan.value;
  if (!plan) return '尚未生成';
  const steps = plan.attempts.map((attempt) => compressionAttemptLabel(attempt.methodKind));
  if (plan.continueUncompressedIfFits) steps.push('仍能放下时继续一次');
  return steps.length > 0 ? steps.join(' → ') : '无可执行方法';
});

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function compressionKindLabel(kind: LlmCompressionMethodKind | undefined): string {
  switch (kind) {
    case 'auto': return '自动选择';
    case 'provider_native': return 'Provider 原生压缩';
    case 'llm_summary': return '单次 LLM 摘要';
    case 'segmented_summary': return '本地分段摘要';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    case 'disabled': return '关闭';
    default: return '未知方法';
  }
}

function compressionAttemptLabel(kind: string): string {
  if (kind === 'provider_native') return 'Provider 原生压缩';
  if (kind === 'segmented_summary') return '本地分段摘要';
  if (kind === 'llm_summary') return '单次 LLM 摘要';
  if (kind === 'deterministic_summary') return '确定性摘要';
  return kind;
}

function normalizeTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function clampTokenToContext(value: number, contextWindow = props.contextWindowTokens): number {
  const aligned = alignTokenCountToK(value);
  const alignedContextWindow = contextWindow >= TOKEN_STEP
    ? Math.floor(contextWindow / TOKEN_STEP) * TOKEN_STEP
    : undefined;
  return alignedContextWindow === undefined ? aligned : Math.min(alignedContextWindow, aligned);
}

function clampPercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(100, Math.max(1, number));
}

function percentForTokens(tokens: number, contextWindow = props.contextWindowTokens): number {
  return contextWindow > 0 ? clampPercent((tokens / contextWindow) * 100) : compressionThresholdPercent.value;
}

function formatTokenLabel(value: number | undefined): string {
  const tokens = normalizeTokenCount(value);
  if (tokens === undefined) return '未设置';
  const kilo = tokens / 1_000;
  if (kilo >= 1) return `${Number.isInteger(kilo) ? kilo.toFixed(0) : kilo.toFixed(1)}k`;
  return `${tokens}`;
}

function numericInputValue(event: Event): number | undefined {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function updateCompressionAutoEnabled(enabled: boolean): void {
  emit('update-trigger', { mode: enabled ? 'token_threshold' : 'manual' });
}

function updateCompressionThresholdTokens(event: Event): void {
  const value = numericInputValue(event);
  if (value === undefined) return;
  updateCompressionThresholdFromTokens(value);
}

function updateCompressionThresholdFromTokens(value: number): void {
  const tokens = clampTokenToContext(value);
  emit('update-trigger', {
    thresholdUnit: 'tokens',
    thresholdTokens: tokens,
    thresholdPercent: percentForTokens(tokens)
  });
}

function clampBodyTargetTokens(value: number): number {
  const aligned = alignTokenCountToK(value);
  const floor = alignTokenCountToK(MIN_LLM_COMPRESSION_BODY_TARGET_TOKENS);
  const ceiling = compressionBodyTargetMaxTokens.value;
  const alignedCeiling = ceiling >= TOKEN_STEP ? Math.floor(ceiling / TOKEN_STEP) * TOKEN_STEP : undefined;
  const bounded = alignedCeiling === undefined ? aligned : Math.min(alignedCeiling, aligned);
  return Math.max(floor, bounded);
}

function updateBodyTargetTokens(event: Event): void {
  const value = numericInputValue(event);
  if (value === undefined) return;
  updateBodyTargetFromTokens(value);
}

function updateBodyTargetFromTokens(value: number): void {
  emit('update-body-target-tokens', clampBodyTargetTokens(value));
}

function updateMethodKind(value: string): void {
  emit('update-method-kind', value as SelectableCompressionMethodKind);
}

function updateMaxDurationMinutes(event: Event): void {
  const value = normalizeLlmCompressionMaxDurationMinutes(numericInputValue(event));
  (event.target as HTMLInputElement).value = String(value);
  emit('update-max-duration-minutes', value);
}

function updateNativeTrustMode(enabled: boolean): void {
  emit('update-native-trust-mode', enabled ? 'trust_configured_endpoint' : 'verified_only');
}

function updateSummaryReasoningMode(value: string): void {
  emit('update-summary-reasoning-mode', value as LlmSummaryReasoningMode);
}

function fallbackEnabled(value: LlmCompressionFallbackKind): boolean {
  return configuredFallbacks.value.includes(value);
}

function updateFallback(value: LlmCompressionFallbackKind, enabled: boolean): void {
  const selected = new Set(configuredFallbacks.value);
  if (enabled) selected.add(value);
  else selected.delete(value);
  emit('update-fallbacks', FALLBACK_OPTIONS
    .map((option) => option.value)
    .filter((candidate) => selected.has(candidate)));
}
</script>

<template>
  <section class="compression-settings" aria-label="上下文压缩">
    <header class="compression-settings-header">
      <LcCheckbox :model-value="compressionAutoEnabled" aria-label="启用自动压缩"
        @update:model-value="updateCompressionAutoEnabled">自动压缩</LcCheckbox>
      <LlmSettingHint :text="`当前策略：${compressionKindLabel(config?.kind ?? 'auto')}`"
        details="达到完整输入阈值时准备压缩。关闭自动触发后，仍可手动压缩。设置在后续请求建立时生效。" />
    </header>
    <div class="global-settings-grid compression-settings-grid">
      <div v-if="compressionAutoEnabled" class="compression-trigger-panel global-settings-field-wide">
        <div class="compression-trigger-head">
          <div>
            <span class="compression-trigger-title">完整输入 Token 触发阈值</span>
            <LlmSettingHint text="只决定何时压缩。" details="完整输入包含系统要求、工具定义、运行提醒和对话。" />
          </div>
        </div>

        <div class="compression-threshold-control">
          <label class="global-settings-field compression-threshold-input-field">
            <span>完整输入 Token 数</span>
            <span class="threshold-input-shell">
              <input
                class="token-number-input"
                aria-label="压缩触发 Token"
                :value="compressionThresholdInputValue"
                type="number"
                :min="TOKEN_STEP"
                :max="contextWindowTokens || undefined"
                :step="TOKEN_STEP"
                :disabled="contextWindowTokens <= 0"
                @change="updateCompressionThresholdTokens"
              />
              <span>Token</span>
            </span>
          </label>

          <TokenThresholdSlider
            :model-value="compressionThresholdTokens"
            :max-tokens="contextWindowTokens"
            :step-tokens="TOKEN_STEP"
            :recommended-tokens="recommendedThresholdTokens"
            :disabled="contextWindowTokens <= 0"
            aria-label="拖拽调整自动压缩触发阈值"
            @update:model-value="updateCompressionThresholdFromTokens"
          />
        </div>
      </div>

      <div class="compression-trigger-panel global-settings-field-wide">
        <div class="compression-trigger-head">
          <div>
            <span class="compression-trigger-title">保留原文 Token</span>
            <LlmSettingHint text="逐字保留的对话正文，不是摘要长度。"
              :details="`默认 ${formatTokenLabel(DEFAULT_LLM_COMPRESSION_BODY_TARGET_TOKENS)} Token；实际保留量最多取触发阈值以下剩余空间的一半。`" />
          </div>
        </div>

        <div class="compression-threshold-control">
          <label class="global-settings-field compression-threshold-input-field">
            <span>保留 Token 数</span>
            <span class="threshold-input-shell">
              <input
                class="token-number-input"
                aria-label="保留原文 Token"
                :value="compressionBodyTargetInputValue"
                type="number"
                :min="MIN_LLM_COMPRESSION_BODY_TARGET_TOKENS"
                :max="compressionBodyTargetMaxTokens || undefined"
                :step="TOKEN_STEP"
                :disabled="compressionBodyTargetMaxTokens <= 0"
                @change="updateBodyTargetTokens"
              />
              <span>Token</span>
            </span>
          </label>

          <TokenThresholdSlider
            :model-value="compressionBodyTargetTokens"
            :max-tokens="compressionBodyTargetMaxTokens"
            :step-tokens="TOKEN_STEP"
            :recommended-tokens="recommendedBodyTargetTokens"
            :disabled="compressionBodyTargetMaxTokens <= 0"
            aria-label="拖拽调整保留原文 Token"
            @update:model-value="updateBodyTargetFromTokens"
          />
        </div>
      </div>


      <label class="global-settings-field">
        <span>压缩策略</span>
        <SettingsDropdown :model-value="activeMethodKind" :options="methodOptions" title="选择压缩策略"
          @update:model-value="updateMethodKind" />
      </label>
      <label class="global-settings-field">
        <span>压缩使用的模型渠道</span>
        <SettingsDropdown v-model="providerConfigId" :options="providerConfigOptions"
          title="选择压缩使用的渠道配置" searchable search-placeholder="筛选渠道..." />
      </label>
      <label class="global-settings-field">
        <span>单次压缩最长时间（分钟）</span>
        <input class="token-number-input" :value="compressionMaxDurationMinutes" type="number" :min="1"
          :max="MAX_LLM_COMPRESSION_DURATION_MINUTES" :step="1" aria-label="单次压缩最长时间（分钟）"
          @change="updateMaxDurationMinutes" />
        <LlmSettingHint :text="`默认 ${DEFAULT_LLM_COMPRESSION_MAX_DURATION_MINUTES} 分钟，包含等待与生成。`" />
      </label>
      <div class="global-settings-field">
        <span>摘要思考强度</span>
        <SettingsDropdown :model-value="summaryReasoningMode" :options="summaryReasoningOptions"
          title="选择总结模型推理意图" @update:model-value="updateSummaryReasoningMode" />
        <LlmSettingHint text="按总结模型能力映射。" :details="summaryReasoningPlan?.description ?? '尚未解析总结模型能力。'" />
      </div>
      <div class="global-settings-field compression-native-actions">
        <HoverTooltipPanel panel-title="压缩能力与执行顺序" :rows="[
          { label: '渠道 / 模型', value: `${providerLabel(providerConfig?.provider)} · ${providerModelId || '未选择'}` },
          { label: '能力来源', value: capabilitySourceLabel },
          { label: '原生压缩', value: capabilities?.nativeCompaction.reason ?? '尚未解析' },
          { label: '执行顺序', value: executionPlanLabel }
        ]">
          <button type="button" class="compression-capability-badge">原生压缩：{{ nativeCapabilityLabel }}</button>
        </HoverTooltipPanel>
        <button v-if="providerConfig && ['openai-responses', 'claude'].includes(providerConfig.provider)"
          type="button" class="settings-native-probe" @click="emit('verify-native', providerConfig.id, providerModelId)">
          验证原生端点（会调用一次）
        </button>
        <LcCheckbox v-if="canDeclareNativeCapability" :model-value="nativeTrustMode === 'trust_configured_endpoint'"
          aria-label="信任当前兼容端点支持 Provider 原生压缩" @update:model-value="updateNativeTrustMode">
          信任端点声明
        </LcCheckbox>
      </div>
      <section class="compression-fallback-list global-settings-field-wide" aria-label="压缩后备策略">
        <span class="compression-trigger-title">失败后依次尝试</span>
        <div v-for="option in FALLBACK_OPTIONS" :key="option.value" class="compression-fallback-option">
          <LcCheckbox :model-value="fallbackEnabled(option.value)" :aria-label="option.label"
            @update:model-value="updateFallback(option.value, $event)">{{ option.label }}</LcCheckbox>
          <LlmSettingHint text="说明" :details="option.description" />
        </div>
      </section>
      <LlmSummaryGenerationEditor class="global-settings-field-wide" :value="config?.llmSummary?.generationConfig"
        :capabilities="capabilities" :mode="summaryReasoningMode" :target-tokens="config?.llmSummary?.targetTokens"
        @update="emit('update-summary-generation-config', $event)" />
    </div>
  </section>
</template>

<style scoped>
.compression-settings { display: grid; gap: var(--space-2); padding-top: var(--space-2); min-width: 0; }
.compression-settings-header { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.compression-settings-grid { margin: 0; }
.compression-trigger-panel { display: grid; gap: var(--space-2); padding-block: var(--space-2); border-bottom: 1px solid var(--vscode-panel-border); }
.compression-trigger-title { font-size: var(--font-size-sm); font-weight: 600; }
.compression-trigger-head > div { display: grid; gap: var(--space-1); }
.compression-native-actions { align-items: start; }
.compression-capability-badge, .settings-native-probe { padding: var(--space-1) var(--space-2); background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); font: inherit; cursor: pointer; }
.compression-capability-badge:hover, .settings-native-probe:hover { background: var(--vscode-list-hoverBackground); }
.compression-fallback-list { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; }
.compression-fallback-option { display: inline-flex; gap: var(--space-1); align-items: center; }
.compression-threshold-control { display: grid; grid-template-columns: minmax(130px, 190px) minmax(0, 1fr); gap: var(--space-3); align-items: center; }
.threshold-input-shell { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }
.threshold-input-shell input { min-width: 0; border: 0; border-radius: 0; background: transparent; }
.threshold-input-shell > span { padding: 0 var(--space-2); font-size: var(--font-size-xs); }
.token-number-input[type='number'] { appearance: textfield; -moz-appearance: textfield; }
.token-number-input[type='number']::-webkit-outer-spin-button, .token-number-input[type='number']::-webkit-inner-spin-button { margin: 0; -webkit-appearance: none; }
@media (max-width: 720px) { .compression-threshold-control { grid-template-columns: 1fr; } }
</style>
