# Responses 多轮缓存修复记录

日期：2026-10-14。

## 修改

新 Responses 请求冻结 `turnReminderDelivery=user_history`。实际发送的提醒和重注入输入按原文留在生产者首次输出前，提醒注明它代表当次回复前的状态；普通预算和原生压缩计入这些 user 快照。旧配方保持实际发送语义，文本摘要继续使用语义 Context。

显式缓存读取点沿最新物理响应的真实输入边界投影到最终编码，写入点在本次输入末尾；HTTP 与 WebSocket 统一数组工具输出。缓存 Key 直接使用 `conversationId`，请求体显式覆盖仍优先。移除了该路径的二次缓存 Key 哈希和诊断哈希。

生产者解析覆盖原生逐项输出和纯工具调用。普通工具结果与用户编辑不充当提醒锚点；分支复用同一 ContextSegment 的原始来源选择器，删除祖先后仍可识别。结构读取保持纯元数据，内容读取的来源证明与传输复用同一批字节。

## 验证

- 主工程编译、前端构建和类型检查、合同检查通过。
- 隔离临时目录运行全部本地行为测试：440 通过，1 项 Linux 平台条件跳过，0 失败。
- 接入库：28 个文件、347 项测试通过。
- 回归覆盖多轮前缀、显式断点、原生 HTTP 后继、纯工具输出、附件重注入、跨模型 user 身份、预算、结构零正文读取和祖先删除后的分支来源。

## 真实渠道复测

渠道 `https://api.otto114514.com/v1`，模型 `LI-gpt-6-astra`，HTTP/SSE，缓存 Key 模式。使用本次编译代码的 `LlmCapabilityFullRequestAdapter → LlmProvider → unified-llm-provider` 发送三轮合成参考文本；每轮增加新输入并更新运行快照，间隔 4 秒。测试内容不包含工作区正文。

| 轮次 | 输入 token | 缓存 token | 本轮比例 |
| --- | ---: | ---: | ---: |
| 1 | 4092 | 0 | 0% |
| 2 | 4172 | 0 | 0% |
| 3 | 4252 | 3968 | 93.3% |

三轮 HTTP 均为 200、回复均为 `OK`，服务端返回 `gpt-6-astra`。每轮返回的 `prompt_cache_key` 与 `conversationId` 一致，第二、三轮完整保留上一轮输入前缀，未发送 `Session-Id`、`session_id` 或 `x-session-id`。第三轮标准 `input_tokens_details.cached_tokens=3968` 经 LimCode 转换后仍为 `cachedContentTokenCount=3968`。

本机原临时目录中存在缺少 owner.json 的旧文件锁，导致无关的 TE10 文件操作测试失败；同一代码在独立临时目录中通过。原现场保留，产品文件操作代码未作改动。
