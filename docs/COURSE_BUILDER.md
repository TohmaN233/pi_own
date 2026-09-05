# Course Builder：备课与 Beamer

本功能通过普通 Pi 会话的 `course-builder` Mode Pack 加载专用插件及固定教学指导，
复用 Pi 原生对话与 LearningHarness 的 SQLite 连接。不是第二套 Agent Loop。

## 开始

更新 `main`，在仓库根目录运行 `start-learning-harness.ps1`。Node 最低要求以根
`package.json` 为准。先新建/打开一个普通 Pi 会话，再点击模式栏的“备课”。
课程绑定的学生会话不能切换成教师会话；备课项目绑定不能静默更换。

工作区地址 `/course-builder?sessionId=实际会话ID` 会请求并验证真实 Mode Pack，
不是只切换一个页面名称。没有活动 Pi Runtime 时明确报错。

1. 编辑项目 JSON：课程、周数、课次、时长、学生层次、目标和 Beamer 配置。
2. 导入 PPTX、PDF、TeX、Markdown、文本；PNG/JPEG 可作为独立资产。
3. 点击“分析资料”“生成学期计划”，在原生 Pi 对话查看完整流式输出。
4. 阅读工作区内的实际已保存草案，批准或写意见要求修改。
5. 学期计划批准后生成单课计划；单课批准后生成 Beamer。
6. 编译、检查日志、下载 PDF。人工逐页检查后才点击“接受”。

模型使用 Pi 设置中的 Provider/Model。没有真实凭据时，不能生成教学文本。
工作区按钮发送任务给当前 Pi，不会自行创建另一个模型循环。可在自定义消息框
提交修订要求；状态会定期刷新。选择旧计划的 revision 会被拒绝。

## 编译只用于可信本地源码

默认关闭 TeX 执行。明确认可源码后，在启动服务前设置：

```powershell
$env:PI_COURSE_BUILDER_TRUSTED_TEX = "1"
# 仅当 xelatex 不在 PATH 中时设置：
$env:PI_XELATEX_PATH = "C:\path\to\xelatex.exe"
.\start-learning-harness.ps1
```

`-no-shell-escape`、受限路径、输入/输出预算、临时目录、环境过滤和超时并不等于
操作系统沙箱。不要编译故意恶意的第三方 TeX。环境变量只能由本地所有者设置，
Agent 不获得任意 shell、write/edit 或教师批准工具。命令缺失会显示失败，不伪造 PDF。

源码必须是独立 Beamer 文档，不支持任意 `input/include` 和外部 BibTeX。
使用 `thebibliography`。导入模板作为资料，由 Agent 合并为独立源码。
图片通过 `assets/材料ID.png`（对应 jpg/jpeg/pdf 扩展名）引用，并列入 `assetMaterialIds`。

## 实际范围

- PPTX：ZIP 预算、CRC、实际 presentation 页序、正文和 Speaker Notes。不是视觉复刻。
- PDF：有预算的 pdftotext 文本提取，不进行 OCR，不承诺图片/公式识别质量。
- 学期与单课：严格字段、课程容量/目标/材料检查、乐观并发与祖先 revision 绑定。
- 审批：教师 UI 的单独动作；模型工具表中不存在 approve/accept。
- 课件：独立 .tex、实际编译回执、PDF/日志哈希、当前证据接受与恢复。
- 源码审查：固定规则和日志诊断；不是语义正确性证明，也不是截图视觉检查。
- 可视化：已有固定 VisualHost 的单独产物。当前不自动转图片插入指定 Frame。
- 保存：同一 SQLite/WAL 所有者，原始资料/PDF/日志持久化，修改审计与版本检查。

本版本是单用户本地教师工作区，不是多租户学校服务；请求 Origin 检查和教师 UI
header 不是独立用户身份系统。普通 Coding Mode 本身有本机权限，不应赋予不可信用户。

## 自动测试与未完成事项

本地完整提交前检查（不会推送、触发 Actions 或合并）：

```sh
bash scripts/verify-course-builder-local.sh
```

该检查先拒绝缺入口/接线文件、不兼容 Node 和未安装的锁定依赖，再运行真实
XeLaTeX 回归、根仓库构建/检查/隔离测试，以及 Pi Web 类型检查、lint、测试和构建。
任何一步失败即退出；专项回归通过不能代替整个检查通过。

专项调试：

```sh
PI_TEST_XELATEX=1 node --experimental-strip-types --test scripts/course-builder*.test.mjs
npm run check
npm test --prefix apps/pi-web
npm run build --prefix apps/pi-web
```

回归测试先在旧失败树运行并失败，再修复入口/实际接线。真实 XeLaTeX 测试要求
编译器存在；不把跳过测试或仅存在源码当成通过。远端 CI 结论以该 PR exact HEAD 为准。

未来：可编辑 PPTX 输出、母版/图片语义复刻、OS 沙箱、自动逐页视觉审查、完整教师/学生
发行包物理分离、完整 Teach-back 状态机、多模型教学效果评测。
