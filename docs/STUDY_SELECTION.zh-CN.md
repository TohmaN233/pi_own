# Study 来源选择与提问

Study 工作区的阅读器支持在当前已加载的来源分块中用鼠标或键盘选择文字。选择必须落在同一个分块内；页面会显示摘录、`sourceHash`、`chunkId` 和原始 `locator`，并将摘录限制为 4,000 个字符。切换来源、来源版本或失去当前分块时，选择会清除，避免把旧版本内容带入新问题。

选择面板提供两个连续动作：

- **加入笔记**把 `[locator · sourceHash]` 和摘录放入现有笔记编辑框，用户补充标题或理解后保存。保存仍走原来的来源笔记接口，因此笔记保留来源版本身份。
- **发送到当前对话**把问题发送到页面右侧已经挂载的原始 Pi `ChatWindow`。提示词只携带选中的摘录和精确身份字段，不启动自动 Research、考试或另一套对话。

发送后阅读器不会重新定位或收起，当前来源和已读取分块继续留在原处。知识笔记和知识节点每页显示 12 条，使用“上一页 / 下一页”访问后续内容；长列表不再静默截断到前 12 条。

## 本地协议验收

保持仓库现有的 Next 服务运行在 `127.0.0.1:30185`，从 `apps/pi-web` 执行：

```powershell
$env:PI_PLAYWRIGHT_MODULE='<absolute-path-to-playwright-module>'
node scripts/study-selection-browser.mjs
```

脚本使用 Playwright 实际打开 Study 页面，并仅在浏览器页内拦截本地 `/api` 请求，使用合成来源、笔记和节点数据验证：

- 同一来源分块的鼠标 / 键盘可访问选择、原样 `<b>` 文本与 4,000 字符边界；
- 原始 ChatWindow 输入框、精确 `sourceHash` / `chunkId` / `locator` / quote 提问，以及笔记保存；
- 来源 hash 变化和来源切换后的选择失效；
- 笔记和节点的第二页可访问性；
- 没有外部模型、Provider 或付费调用。

脚本会把 `seed.json`、`selection-browser-evidence.json`、`selection-browser.png` 写入 `.artifacts/study-research/selection/`。这些是工程协议证据，不代表论文内容的学术正确性或验收结论。
