<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconCloudDown, IconPencil, IconPlus, IconSearch, IconTrash } from '@tabler/icons-vue';
import type { LlmProviderConfigRecord, LlmProviderKind, LlmProviderModelConfigRecord, LlmProviderModelRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';
import ChannelConfigEditor from './ChannelConfigEditor.vue';
import ModelFetchDialog from './ModelFetchDialog.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import { OPENAI_COMPATIBLE_SERVICE_PRESETS } from '@shared/openAICompatibleDialect';
import { openAICompatibleThinkingProbeEvidence } from '@shared/modelCapabilities';
import {
  describeOpenAICompatibleThinkingProbe,
  OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS,
  openAICompatibleThinkingProbeTime
} from '@shared/openAICompatibleThinkingProbe';

const settings = useGlobalSettingsStore();
const { loading: channelLoading, text: channelLoadingText } = useSettingsLoadingText('渠道配置', 'global', undefined, {
  globalSettingsSections: ['llm', 'llmProviderConfigs', 'llmCompression', 'llmCompressionConfigs'] as const
});
const createOpen = ref(false);
const createProvider = ref<LlmProviderKind>('openai-compatible');
const renameOpen = ref(false);
const deleteConfirmOpen = ref(false);
const newModelOpen = ref(false);
const newModelName = ref('');
const modelFilter = ref('');
const modelListScroller = ref<HTMLElement | null>(null);
const clearModelsConfirmOpen = ref(false);
const selectedEditorModelId = ref('');
const selectedProviderConfigId = ref('');
const dialogProviderConfigId = ref('');
const deleteModelConfigConfirmOpen = ref(false);
const deletingModelConfigId = ref('');
/** “测试这个模型”确认框：两处入口（思考参数写法字段、LLM 列表每行）共用。 */
const thinkingTestModelId = ref('');
const thinkingTestConfirmOpen = ref(false);

const providerOptions: SettingsDropdownOption[] = [
  {
    value: 'openai-compatible',
    label: 'OpenAI Compatible',
    description: 'DeepSeek、Kimi、智谱、百炼等都选这一种，思考参数写法自动识别'
  },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' }
];

/** 新建 OpenAI 兼容渠道时按服务商填好接口地址；空值表示 OpenAI 或其他服务，自己填地址。 */
const createServiceOptions: SettingsDropdownOption[] = [
  { value: '', label: 'OpenAI 或其他服务', description: '先用 OpenAI 的地址，建好后可以改成任意兼容地址' },
  ...OPENAI_COMPATIBLE_SERVICE_PRESETS.map((preset) => ({ value: preset.key, label: preset.label, description: preset.baseUrl }))
];
const createService = ref('');

watch(() => settings.llmProviderConfigs.configs.map(config => config.id), ids => {
  if (ids.includes(selectedProviderConfigId.value)) return;
  selectedProviderConfigId.value = ids.includes(settings.llm.activeProviderConfigId)
    ? settings.llm.activeProviderConfigId : ids[0] ?? '';
  selectedEditorModelId.value = '';
}, { immediate: true, flush: 'sync' });
const editingConfig = computed(() => settings.llmProviderConfigs.configs.find(config => config.id === selectedProviderConfigId.value));
const dialogConfig = computed(() => settings.llmProviderConfigs.configs.find(config => config.id === dialogProviderConfigId.value));
const selectedModelConfig = computed(() => editingModelConfigs.value.find(item => item.modelId === selectedEditorModelId.value));
const editorTargetOptions = computed<SettingsDropdownOption[]>(() => [
  { value: '', label: '渠道默认配置' },
  ...(editingConfig.value?.models ?? []).map(model => ({ value: model.id, label: model.name,
    description: editingModelConfigs.value.some(item => item.modelId === model.id) ? '独立完整副本' : '使用渠道默认配置' }))
]);
const editorModelId = computed({
  get: () => editingConfig.value?.models.some(model => model.id === selectedEditorModelId.value) ? selectedEditorModelId.value : '',
  set: (value: string) => { selectedEditorModelId.value = value; }
});
const canDeleteConfig = computed(() => !!editingConfig.value && settings.llmProviderConfigs.configs.length > 1);
const editingConfigId = computed({
  get: () => editingConfig.value?.id ?? '',
  set: (configId: string) => { selectedProviderConfigId.value = configId; selectedEditorModelId.value = ''; }
});
const configPageOptions = computed<SettingsDropdownOption[]>(() =>
  settings.llmProviderConfigs.configs.map((config) => ({ value: config.id, label: config.name, description: providerLabel(config.provider) }))
);
const editingProviderLabel = computed(() => providerLabel(editingConfig.value?.provider));
const filteredModels = computed<LlmProviderModelRecord[]>(() => {
  const keyword = modelFilter.value.trim().toLowerCase();
  const models = editingConfig.value?.models ?? [];
  if (!keyword) return models;
  return models.filter((model) => {
    return model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword);
  });
});

const hasModels = computed(() => (editingConfig.value?.models.length ?? 0) > 0);
const canClearModels = computed(() => !!editingConfig.value && hasModels.value);
const editingModelConfigs = computed<LlmProviderModelConfigRecord[]>(() => editingConfig.value?.modelConfigs ?? []);
const deletingModelConfig = computed(() => dialogConfig.value?.modelConfigs.find((config) => config.id === deletingModelConfigId.value));
const deletingModelConfigLabel = computed(() => deletingModelConfig.value ? modelLabel(deletingModelConfig.value.modelId) : '该 LLM');

/** 获取模型弹窗对应配置中已存在的模型 ID，用于在弹窗中标记「已添加」状态。 */
const fetchedDialogExistingModelIds = computed<string[]>(() => {
  const configId = settings.fetchedModelsDialog.configId;
  const config = settings.llmProviderConfigs.configs.find((c) => c.id === configId);
  return config?.models.map((m) => m.id) ?? [];
});

function formatModelTime(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function updateConfigField<K extends keyof LlmProviderConfigRecord>(key: K, value: LlmProviderConfigRecord[K]): void {
  settings.updateActiveLlmProviderConfig({ [key]: value } as Partial<LlmProviderConfigRecord>, editingConfigId.value);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value;
}

function modelLabel(modelId: string): string {
  const model = editingConfig.value?.models.find((candidate) => candidate.id === modelId);
  return model?.name?.trim() || modelId;
}

function createModelSpecificConfig(): void {
  const modelId = editorModelId.value;
  if (!modelId) return;
  settings.createModelConfigForActiveConfig(modelId, editingConfigId.value);
}

function openDeleteModelConfigConfirm(modelConfigId: string): void {
  dialogProviderConfigId.value = editingConfigId.value;
  deletingModelConfigId.value = modelConfigId;
  deleteModelConfigConfirmOpen.value = true;
}

function confirmDeleteModelConfig(): void {
  const id = deletingModelConfigId.value;
  deleteModelConfigConfirmOpen.value = false;
  deletingModelConfigId.value = '';
  if (!id) return;
  settings.deleteModelConfigFromActiveConfig(id, dialogProviderConfigId.value);
}

function cancelDeleteModelConfig(): void {
  deleteModelConfigConfirmOpen.value = false;
  deletingModelConfigId.value = '';
}

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function openCreate(): void {
  createProvider.value = 'openai-compatible';
  createService.value = '';
  createOpen.value = true;
}

function confirmCreate(name: string): void {
  createOpen.value = false;
  const preset = createProvider.value === 'openai-compatible'
    ? OPENAI_COMPATIBLE_SERVICE_PRESETS.find((candidate) => candidate.key === createService.value)
    : undefined;
  editingConfigId.value = settings.createLlmProviderConfig(name, createProvider.value, preset?.baseUrl);
}

function cancelCreate(): void {
  createOpen.value = false;
}

function updateCreateProvider(value: string): void {
  createProvider.value = value as LlmProviderKind;
}

function openNewModel(): void {
  dialogProviderConfigId.value = editingConfigId.value;
  newModelName.value = '';
  newModelOpen.value = true;
}

function confirmNewModel(modelId: string): void {
  newModelOpen.value = false;
  settings.addModelToActiveConfig(modelId, newModelName.value, dialogProviderConfigId.value);
  newModelName.value = '';
}

function cancelNewModel(): void {
  newModelOpen.value = false;
  newModelName.value = '';
}

function updateNewModelName(event: Event): void {
  newModelName.value = (event.target as HTMLInputElement).value;
}

function openClearModelsConfirm(): void {
  dialogProviderConfigId.value = editingConfigId.value;
  if (!canClearModels.value) return;
  clearModelsConfirmOpen.value = true;
}

function confirmClearModels(): void {
  clearModelsConfirmOpen.value = false;
  settings.clearModelsFromActiveConfig(dialogProviderConfigId.value);
}

function cancelClearModels(): void {
  clearModelsConfirmOpen.value = false;
}

function removeModel(modelId: string): void {
  settings.removeModelFromActiveConfig(modelId, editingConfigId.value);
}

function openRename(): void {
  dialogProviderConfigId.value = editingConfigId.value;
  if (!editingConfig.value) return;
  renameOpen.value = true;
}

function confirmRename(name: string): void {
  const config = settings.llmProviderConfigs.configs.find(item => item.id === dialogProviderConfigId.value);
  renameOpen.value = false;
  if (!config) return;
  settings.renameLlmProviderConfig(config.id, name);
}

function cancelRename(): void {
  renameOpen.value = false;
}

function openDeleteConfirm(): void {
  dialogProviderConfigId.value = editingConfigId.value;
  if (!canDeleteConfig.value) return;
  deleteConfirmOpen.value = true;
}

function confirmDelete(): void {
  const config = settings.llmProviderConfigs.configs.find(item => item.id === dialogProviderConfigId.value);
  deleteConfirmOpen.value = false;
  if (!config) return;
  settings.deleteLlmProviderConfig(config.id);
}

function addFetchedModels(models: LlmProviderModelRecord[]): void {
  settings.addFetchedModelsToConfig(models);
}

function cancelDelete(): void {
  deleteConfirmOpen.value = false;
}

const isOpenAICompatibleChannel = computed(() => editingConfig.value?.provider === 'openai-compatible');
const thinkingTestDescription = computed(() =>
  `会向「${modelLabel(thinkingTestModelId.value)}」发送最多 ${OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS} 次很短的请求（每次只有一句“Reply with OK.”，看到第一段回复就断开），`
  + '测出它用哪种思考参数写法、能不能关闭思考、接受哪些思考强度，可能产生少量费用。'
  + '结果只对这个渠道的这个模型有效；改了接口地址就要重新测试。手动指定了写法时，发送仍按手动指定。'
);

const thinkingTestTooltipRows = [
  { label: '测什么', value: '这个模型用哪种思考参数写法、能不能关闭思考、接受哪些思考强度' },
  { label: '怎么测', value: `发最多 ${OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS} 次很短的请求，可能产生少量费用；点了会先确认` }
];

function thinkingProbeFor(modelId: string) {
  const config = editingConfig.value;
  return config ? settings.thinkingProbeState(config.id, modelId) : undefined;
}

function thinkingProbeEvidenceFor(modelId: string) {
  const config = editingConfig.value;
  return config ? openAICompatibleThinkingProbeEvidence(config, modelId) : undefined;
}

/** LLM 列表里“已测试”标签的悬浮说明。 */
function thinkingProbeRows(modelId: string) {
  const evidence = thinkingProbeEvidenceFor(modelId);
  if (!evidence) return [];
  const parts = describeOpenAICompatibleThinkingProbe(evidence).split('；');
  return [
    ...(parts.length === 3
      ? [
          { label: '写法', value: parts[0]! },
          { label: '关闭思考', value: parts[1]! },
          { label: '强度', value: parts[2]! }
        ]
      : [{ label: '结果', value: parts.join('；') }]),
    { label: '测试时间', value: openAICompatibleThinkingProbeTime(evidence.verifiedAt) || '未知' }
  ];
}

function openThinkingTest(modelId: string, providerConfigId = editingConfigId.value): void {
  const provider = settings.llmProviderConfigs.configs.find(item => item.id === providerConfigId);
  if (provider?.provider !== 'openai-compatible' || !modelId.trim() || settings.thinkingProbeState(providerConfigId, modelId)?.status === 'running') return;
  dialogProviderConfigId.value = providerConfigId;
  thinkingTestModelId.value = modelId;
  thinkingTestConfirmOpen.value = true;
}

function confirmThinkingTest(): void {
  const config = settings.llmProviderConfigs.configs.find(item => item.id === dialogProviderConfigId.value);
  const modelId = thinkingTestModelId.value;
  thinkingTestConfirmOpen.value = false;
  thinkingTestModelId.value = '';
  if (!config || !modelId) return;
  settings.testOpenAICompatibleThinking(config.id, modelId);
}

function cancelThinkingTest(): void {
  thinkingTestConfirmOpen.value = false;
  thinkingTestModelId.value = '';
}
</script>

<template>
  <section class="global-settings-tab-section" aria-label="渠道设置">
    <header class="global-settings-section-header">
      <div>
        <div class="channel-title-row">
          <h2>渠道</h2>
          <SettingsLoadingInline
            :show="channelLoading"
            :text="channelLoadingText"
          />
        </div>
        <p>浏览和编辑不切换默认渠道或模型；修改已在使用的配置会照常保存生效。</p>
      </div>
    </header>

    <div class="channel-content-shell">
      <div class="channel-content" :aria-busy="channelLoading">
        <div class="channel-config-picker">
      <label class="global-settings-field channel-config-select">
        <span>编辑渠道</span>
        <SettingsDropdown
          v-model="editingConfigId"
          :options="configPageOptions"
          title="选择要编辑的渠道"
          empty-text="暂无渠道配置。"
          searchable
          search-placeholder="筛选配置页…"
        />
      </label>

      <div class="channel-config-actions" aria-label="渠道配置页操作">
        <button type="button" class="model-manager-button" :disabled="!editingConfig || settings.llm.activeProviderConfigId === editingConfig.id" @click="settings.selectLlmProviderConfig(editingConfigId)">
          {{ settings.llm.activeProviderConfigId === editingConfigId ? '全局默认渠道' : '设为默认渠道' }}
        </button>
        <button type="button" class="icon-action" aria-label="新建配置页" @click="openCreate">
          <IconPlus stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="重命名配置页" :disabled="!editingConfig" @click="openRename">
          <IconPencil stroke="2" aria-hidden="true" />
        </button>
        <button type="button" class="icon-action" aria-label="删除配置页" :disabled="!canDeleteConfig" @click="openDeleteConfirm">
          <IconTrash stroke="2" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div v-if="editingConfig" class="global-settings-grid">
      <label class="global-settings-field global-settings-field-wide">
        <span>渠道类型</span>
        <input :value="editingProviderLabel" type="text" readonly />
      </label>

      <label class="global-settings-field global-settings-field-wide">
        <span>接口地址（Base URL）</span>
        <input :value="editingConfig.baseUrl" type="text" placeholder="https://api.openai.com/v1" @input="updateConfigField('baseUrl', inputValue($event))" />
      </label>

      <label class="global-settings-field global-settings-api-key-field global-settings-field-wide">
        <span>API 密钥</span>
        <input :value="editingConfig.apiKey" type="text" placeholder="sk-..." autocomplete="off" spellcheck="false" @input="updateConfigField('apiKey', inputValue($event))" />
      </label>

      <section class="model-manager global-settings-field-wide" aria-label="LLM 列表">
        <header class="model-manager-header">
          <label>LLM 列表</label>
          <div class="model-manager-actions">
            <button type="button" class="model-manager-button" @click="openNewModel">
              <IconPlus stroke="2" aria-hidden="true" />
              <span>新建 LLM</span>
            </button>
            <button type="button" class="model-manager-button" @click="settings.requestModelsForActiveConfig(editingConfigId)">
              <IconCloudDown stroke="2" aria-hidden="true" />
              <span>获取 LLM</span>
            </button>
            <button type="button" class="model-manager-button" :disabled="!canClearModels" @click="openClearModelsConfirm">
              <IconTrash stroke="2" aria-hidden="true" />
              <span>清除全部</span>
            </button>
          </div>
        </header>

        <div class="model-list-container">
          <label class="model-filter-box" aria-label="筛选 LLM">
            <IconSearch stroke="2" aria-hidden="true" />
            <input v-model="modelFilter" type="text" placeholder="筛选 LLM…" />
          </label>

          <div class="model-list-shell">
            <div ref="modelListScroller" class="model-list-scroll">
              <div class="model-list">
                <div v-if="!hasModels" class="model-list-empty">暂无 LLM，请新建 LLM。</div>
                <div v-else-if="!filteredModels.length" class="model-list-empty">没有匹配的 LLM。</div>
                <div
                  v-for="model in filteredModels"
                  :key="model.id"
                  class="model-item"
                  :class="{ enabled: model.id === editorModelId, 'has-model-config': editingModelConfigs.some((config) => config.modelId === model.id) }"
                  role="button"
                  tabindex="0"
                  @click="editorModelId = model.id"
                  @keydown.enter.prevent="editorModelId = model.id"
                  @keydown.space.prevent="editorModelId = model.id"
                >
                  <span class="model-status" aria-hidden="true"></span>
                  <span class="model-info">
                    <span class="model-name-row">
                      <HoverTooltipPanel
                        class="model-identity-tooltip"
                        panel-title="模型信息"
                        :rows="[{ label: '名称', value: model.name }, { label: 'ID', value: model.id }]"
                        tabindex="0"
                        :aria-label="`查看模型信息：${model.name}`"
                      >
                        <span class="model-identity-text">
                          <span class="model-name">{{ model.name }}</span>
                          <span class="model-id">ID: {{ model.id }}</span>
                        </span>
                      </HoverTooltipPanel>
                      <HoverTooltipPanel
                        v-if="isOpenAICompatibleChannel && thinkingProbeEvidenceFor(model.id)"
                        panel-title="思考参数测试结果"
                        :rows="thinkingProbeRows(model.id)"
                        :delay-ms="180"
                      >
                        <span class="model-probe-tag" tabindex="0">已测试</span>
                      </HoverTooltipPanel>
                      <HoverTooltipPanel
                        v-if="isOpenAICompatibleChannel && thinkingProbeFor(model.id)?.status === 'failed'"
                        panel-title="思考参数测试失败"
                        :rows="[{ label: '原因', value: thinkingProbeFor(model.id)?.message ?? '' }]"
                        :delay-ms="180"
                      >
                        <span class="model-probe-tag is-failed" tabindex="0">测试失败</span>
                      </HoverTooltipPanel>
                    </span>
                    <span v-if="model.createdAt" class="model-time">时间：{{ formatModelTime(model.createdAt) }}</span>
                    <span v-if="editingModelConfigs.some((config) => config.modelId === model.id)" class="model-time">已设置 LLM 专属配置</span>
                  </span>
                  <span class="model-actions">
                    <button type="button" class="model-test-btn" :disabled="model.id === editingConfig.model" @click.stop="settings.selectLlmProviderConfigModel(editingConfig.id, model.id)" @keydown.enter.stop @keydown.space.stop>
                      {{ model.id === editingConfig.model ? '渠道默认' : '设为默认模型' }}
                    </button>
                    <HoverTooltipPanel
                      v-if="isOpenAICompatibleChannel"
                      panel-title="测试这个模型"
                      :rows="thinkingTestTooltipRows"
                      :delay-ms="320"
                    >
                      <button
                        type="button"
                        class="model-test-btn"
                        :aria-label="`测试 ${model.name} 的思考参数`"
                        :disabled="thinkingProbeFor(model.id)?.status === 'running'"
                        @click.stop="openThinkingTest(model.id)"
                        @keydown.enter.stop.prevent="openThinkingTest(model.id)"
                        @keydown.space.stop.prevent="openThinkingTest(model.id)"
                      >{{ thinkingProbeFor(model.id)?.status === 'running' ? '测试中…' : '测试' }}</button>
                    </HoverTooltipPanel>
                    <button
                      type="button"
                      class="model-remove-btn"
                      aria-label="移除 LLM"
                      @click.stop="removeModel(model.id)"
                      @keydown.enter.stop.prevent="removeModel(model.id)"
                      @keydown.space.stop.prevent="removeModel(model.id)"
                    ><IconTrash stroke="2" aria-hidden="true" /></button>
                  </span>
                </div>
              </div>
            </div>
            <AdvancedScrollbar :scroller="modelListScroller" variant="minimal" />
          </div>
        </div>
      </section>

      <section class="channel-config-groups global-settings-field-wide" aria-label="配置编辑目标">
        <label class="global-settings-field">
          <span>编辑目标</span>
          <SettingsDropdown v-model="editorModelId" :options="editorTargetOptions" title="编辑渠道默认或模型独立配置" searchable />
        </label>
        <template v-if="editorModelId">
          <p v-if="selectedModelConfig">此模型使用独立完整副本，不与渠道默认配置合并。</p>
          <p v-else>此模型使用渠道默认配置。需要不同参数时，明确创建独立副本。</p>
          <button v-if="!selectedModelConfig" type="button" class="model-manager-button" @click="createModelSpecificConfig">从渠道默认复制为独立配置</button>
          <button v-else type="button" class="model-manager-button" @click="openDeleteModelConfigConfirm(selectedModelConfig.id)">删除独立配置…</button>
          <button v-if="!selectedModelConfig" type="button" class="model-manager-button" @click="editorModelId = ''">编辑渠道默认配置</button>
        </template>
        <KeepAlive>
          <ChannelConfigEditor
            v-if="!editorModelId || selectedModelConfig"
            :key="`${editingConfig.id}:${selectedModelConfig?.id ?? 'default'}`"
            :provider-config-id="editingConfig.id"
            :model-config-id="selectedModelConfig?.id"
            @test-thinking="openThinkingTest"
          />
        </KeepAlive>
      </section>
    </div>


    <div v-else class="global-settings-empty">暂无渠道配置，请新建一个配置页。</div>

    <div class="global-settings-actions">
      <button type="button" class="secondary" @click="settings.requestAll()">重新读取</button>
      <span class="global-settings-status">{{ settings.status || '渠道配置会自动保存' }}</span>
    </div>

      </div>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建配置页"
      label="配置页名称"
      initial-value="新渠道配置"
      placeholder="输入配置页名称"
      confirm-label="新建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    >
      <label class="global-settings-field create-channel-provider-field">
        <span>渠道类型</span>
        <SettingsDropdown :model-value="createProvider" :options="providerOptions" title="选择渠道类型" @update:model-value="updateCreateProvider" />
      </label>
      <label v-if="createProvider === 'openai-compatible'" class="global-settings-field create-channel-provider-field">
        <span>服务商</span>
        <SettingsDropdown :model-value="createService" :options="createServiceOptions" title="选择服务商，自动填好接口地址" @update:model-value="createService = $event" />
      </label>
    </InputPanel>

    <InputPanel
      :open="newModelOpen"
      title="新建 LLM"
      label="LLM ID"
      initial-value=""
      placeholder="输入 LLM ID"
      confirm-label="添加 LLM"
      @confirm="confirmNewModel"
      @cancel="cancelNewModel"
    >
      <label class="global-settings-field create-model-name-field">
        <span>LLM 名称（可选）</span>
        <input :value="newModelName" type="text" placeholder="不填则与 LLM ID 相同" @input="updateNewModelName" />
      </label>
    </InputPanel>

    <InputPanel
      :open="renameOpen"
      title="重命名配置页"
      label="配置页名称"
      :initial-value="dialogConfig?.name ?? ''"
      placeholder="输入配置页名称"
      confirm-label="保存名称"
      @confirm="confirmRename"
      @cancel="cancelRename"
    />

    <ConfirmPanel
      :open="clearModelsConfirmOpen"
      title="清除全部 LLM？"
      description-html="将清除当前配置页下的所有 LLM，并取消当前使用的 LLM，此操作<strong>无法撤销</strong>。"
      confirm-label="清除全部"
      cancel-label="取消"
      @confirm="confirmClearModels"
      @cancel="cancelClearModels"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除配置页？"
      :description="`将删除「${dialogConfig?.name ?? '当前配置'}」这个渠道配置页，此操作无法撤销。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmPanel
      :open="deleteModelConfigConfirmOpen"
      title="删除 LLM 专属配置？"
      :description="`将删除「${deletingModelConfigLabel}」的 LLM 专属配置。删除后该 LLM 会重新使用渠道默认配置，此操作无法撤销。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDeleteModelConfig"
      @cancel="cancelDeleteModelConfig"
    />

    <ConfirmPanel
      :open="thinkingTestConfirmOpen"
      title="测试这个模型？"
      :description="thinkingTestDescription"
      confirm-label="开始测试"
      cancel-label="取消"
      @confirm="confirmThinkingTest"
      @cancel="cancelThinkingTest"
    />

    <ModelFetchDialog
      :open="settings.fetchedModelsDialog.open"
      :loading="settings.fetchedModelsDialog.loading"
      :models="settings.fetchedModelsDialog.models"
      :existing-model-ids="fetchedDialogExistingModelIds"
      @add="addFetchedModels"
      @close="settings.closeFetchedModelsDialog()"
    />
  </section>
</template>

<style scoped>
.channel-config-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.model-name-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.model-identity-tooltip {
  flex: 1;
}

.model-identity-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-identity-tooltip:focus-visible {
  outline: 1px solid var(--vscode-panel-border);
  outline-offset: 2px;
}

.model-probe-tag {
  flex: none;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  cursor: default;
}

.model-probe-tag.is-failed {
  color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
}

.model-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.model-test-btn {
  height: 24px;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.model-test-btn:hover:not(:disabled),
.model-test-btn:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  outline: none;
}

.model-item.has-model-config .model-status {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
}

</style>
