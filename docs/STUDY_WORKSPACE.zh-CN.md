# Study 论文工作区

`/study?sessionId=...` 是已有 Pi 会话的来源优先工作区。页面把持久化的论文来源、有限读取、来源笔记、任务状态、可视化草稿和研究计划放在左侧；右侧恢复同一个 `sessionId` 的原始 Pi 对话。页面不建立课程绑定，也不创建 Study 专用会话。

## 进入与会话

页面用 `useSearchParams` 读取 `sessionId`，入口由 `app/study/page.tsx` 的 `Suspense` 包裹。进入后先独立读取保存的 Study 状态：

```text
GET /api/study-research?sessionId=...
```

右侧对话再按既有 Pi 运行时顺序恢复：先对 `/api/agent/{sessionId}` 发送 `POST {"type":"get_state"}`，再读取 `/api/sessions/{sessionId}`。运行时启动失败会在右侧显示可重试错误，左侧保存的工作区仍可读写。对话区复用 `ChatWindow`、`SkillsConfig` 和 `ProjectConversations`，模式切换使用已有 `SessionModePackOverlay` 的激活流程。

## 来源与有限读取

来源导入表单只提交用户明确填写的 `rootPath` 与 `entryPath`：

```text
POST /api/study-research
{ action: "import", sessionId, rootPath, entryPath,
  expectedPhaseRevision, expectedProjectRevision }
```

来源清单展示当前版本、来源角色、解析器、Hash、定位相关诊断和 `requiresPdfInspection`。页面不会写回来源文件。阅读器每次只请求三个分块，并保留 `offset`：

```text
GET /api/study-research?sessionId=...&action=read
  &sourceId=...&sourceHash=...&offset=0&limit=3
```

“继续读取”使用响应中的 `nextOffset`。TeX 分块的行数和字节边界由服务端读取适配器保证；PDF 以页定位，Word 以段落定位，超长输出由服务端明确报错或受限。PDF 预览只把已登记来源的 URL 交给现有 `PdfPreview`，由内置 PDF viewer 继续使用 `/api/pdf-content` 传输；页面不会让浏览器直接访问任意文件路径。

## 笔记、图谱和导出

笔记表单必须选择当前来源，提交 `sourceId` 和 `sourceHash`，并携带阶段／项目 revision 做 CAS 保存：

```text
POST /api/study-research
{ action: "note", sessionId, sourceId, sourceHash, title, body,
  expectedPhaseRevision, expectedProjectRevision }
```

笔记列表是主要阅读面，关联的来源节点标题会作为笔记标题显示。来源变化后的 `stale` 标记会原样显示。知识图谱只作为可展开摘要，不替代来源笔记。已保存状态还可以通过 `format=markdown` 或 `format=graph` 下载来源保留的笔记／图谱：

```text
GET /api/study-research/export?sessionId=...&format=markdown
GET /api/study-research/export?sessionId=...&format=graph
```

## 可视化与研究计划

Agent 生成的 `VisualizationDraft` 和 `ResearchPlan` 随工作区状态刷新。可视化输入 JSON 可在浏览器内修改并点击“应用本地预览”；页面明确标记“本地预览 · 未写回持久化 revision”。渲染器的 iframe 状态只表示渲染结果，不构成数学验证、独立审阅或发布结论。页面不会自行提交可视化版本，也不会由渲染结果推导研究结论。

## 请求竞态与错误

工作区刷新和来源读取各自使用 `AbortController` 与序号守卫；切换来源或刷新后，旧请求不能覆盖当前选中的版本。HTTP 错误、格式错误、运行时恢复失败、读取失败和 CAS 冲突都在页面上显示，并写入浏览器控制台的 `[study]` 诊断日志。右侧 Pi 恢复失败不会吞掉左侧状态错误。

## 当前范围

当前页面提供来源导入、有限读取、PDF 原页查看、笔记保存、笔记／图谱导出以及只读任务、可视化草稿和研究计划展示。实验执行、版本验证、独立审阅、研究计划编辑和完整实验包导出仍由后续 Host/API 工作接入；页面不会把这些未接入能力伪装成已完成状态。
