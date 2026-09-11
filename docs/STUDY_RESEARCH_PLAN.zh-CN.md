# Study & Research：开源考据、架构与实施计划

版本：V1 / 2026-09-11。基线：`00b19b026bb5a0c14462aa4a1b3d4e7270f0a25a`。
这是可执行地基的计划，实施结果另见验收记录；不能把本文件中的 Future 当已实现。

## 1. 产品边界

一个论文/教材/代码目录对应一个 Study Project；可有多个原生 Pi 对话。Study 的目的不是生产漂亮摘要，而是让人逐步理解、质疑、解释和运行关键内容。Research 复用已理解的材料，提出候选问题与实验。它默认停在计划，没有夜间科研代理、自动租 GPU、自动 pip install 或自动提交论文。

**模型不能保证“自己已经完全理解”。** 将这项要求转换成可检查的准备工作：论文身份、覆盖范围、最小背景、符号表、概念依赖图、贡献故事、逐步证明/实现分析、检查任务和未解决问题。准备记录、模型论证状态、真实运行证据、人类学习记录是四种不同对象。

例：作者声称“任意连续函数都可交换极限与积分”。路线图不能只复述该结论。应保存原句/位置、适用条件、可能缺少的控制条件、反例候选和实际检查过程。**证明有缺口不等于命题为假；数值反例候选不等于已验证反例；单次测试通过不等于普遍证明。**

## 2. 现有代码复用

当前主线已有 Course Builder 同页 ChatWindow、真实 Mode Pack 激活、物理 Skills、版本化计划与人类审批、只读目录关联、可编辑TeX、PDF.js预览和项目对话组织。保留它们，不建立第二个 Agent loop，不复制会话 transcript，不建立第二个SQLite库。

- `packages/learning-harness`：唯一 SQLite/WAL composition root，新增 study/visual Host 的构造。
- `project-workspaces.ts`、`createPersistedGenericSession`：项目身份与原生JSONL会话；创建无需模型密钥。
- `course-builder-import.ts`：复用现有有预算的PDF/PPTX/文本提取；Study自己的目录范围与来源身份独立。
- `MarkdownBody`：公式/代码/Markdown预览；`PdfPreview` 和 `/api/pdf-content`：不被浏览器下载器劫持的PDF展示。
- `mode-pack-inventory`、immutable snapshots、physical extension loader：真正加载study和共享visual插件。
- `VisualHost`：保留旧有固定Renderer；新的交互舞台不改动旧备课产物语义。

## 3. 开源项目：采用什么、不采用什么

以下判断是对代码/公开文档的迁移价值分析，不是教学效果排行榜。完整URL、版本及检查范围在 `STUDY_RESEARCH_SOURCES.json`。

| 优先级 | 项目 | 吸收点 | 不直接照搬 |
|---|---|---|---|
| 非常值得 | ARIS | 主张—最少证据—实验矩阵；替代解释；消融；证明义务、退化边界和反例检查 | 自动运行科研链、硬编码模型、评分到9才停止、无提示执行Bash |
| 非常值得 | PaperQA2 | 来源检索与证据摘取分离；引用和证据可追溯 | RAG命中不能证明论文正确；不搬另一套agent运行时 |
| 推荐 | paper-to-course | 先核实论文身份；从问题到方法、实验、局限的结构；公式/术语拆解 | 所有论文强制六模块/16页；自动产出HTML+PPTX不等于学会 |
| 推荐 | DeepTutor | 阅读/对话/学习动作并列；源目录、内部数据与运行输出隔离 | 不因功能多就整套替换Pi；Mastery标签不是有效性证据 |
| 本期基础库 | Plotly strict | 同一固定数据协议支持2D/3D，旋转缩放、有限参数控制和数据导出 | 不是让模型自由生成网页脚本；不允许任意数据URL/选项 |
| 复用 | KaTeX、现有PDF.js | 即时数学排版、代码与PDF阅读 | 排版不是验证；首版不做任意TeX编译与PDF坐标批注 |
| 采用数据思想 | W3C Annotation/Hypothesis | 引句+位置+来源版本、笔记作者和修订链 | 不复制云账户/多人协同体系 |
| 可选 | Mafs | 未来高质量2D数学拖动组件 | 不单独承担3D |
| 可选 | MathBox | 复杂三维数学场景 | 不先构建通用Shader编辑器 |
| 后续 | Manim | 证明动画和离线视频 | 任意Python/TeX执行要独立执行边界 |
| 后续 | Docling | 表格/公式/版面和page provenance | 重量级模型、OCR不是默认依赖 |
| 后续 | JupyterLite/Pyodide | 浏览器练习、可编辑notebook | 不等价于本机/GPU复现或禁网沙箱 |

### ARIS具体采用策略

`experiment-plan`、`research-refine`、`ablation-planner`、`proof-checker` 的有效设计改写为短、可版本化的本地Skills，保留MIT来源。保留：清晰问题、主次贡献、最强合理基线、关键消融、负结果解释、预算、停止标准、反例与假设追踪。删去：工具全权限、自动运行、无限改稿、指定某品牌模型就是可靠审稿人。

实验首先试图区分假设，而不是“捍卫论文故事”。失败结果必须能降低对idea的信心。不得在看过结果后偷偷改变主要指标、seed集合或数据划分。

## 4. 用户路径与确定性边界

### Study

1. 创建项目，选择只读资料文件夹；扫描名称与文件元数据，不把所有文件塞进prompt。
2. 用户/Agent按需读取，提取正文，保存原始字节摘要与文本摘要。代码按行、PDF按提取文本阅读；提取失败明确标注，不能补猜原文。
3. Agent保存阅读地图：`scope, story, contribution, nodes, uncertainties`。节点含最小前置、符号/定义、解释、理解检查、证据及未解决问题。节点DAG不得有环，不允许凭空引用。
4. 用户选中一个节点深入讲解。证明须逐步说明用了哪些假设；实现须将算法步骤对到具体行并区分代码事实和解释。
5. Markdown/TeX数学预览；用户笔记和Agent建议分别署名。注释锁定sourceHash/行/引句，来源变动后保持历史并标陈旧，不静默迁移。
6. 用户可以标记待学/正在学/自己能解释，并写一次具体尝试。Agent不得冒充用户提交掌握度。首版不声称完整自适应排课或掌握度测量。

### Research

1. 在当前阅读地图基础上生成候选方向，必须说明来自哪一处限制/疑点/未解决问题，而不是生成泛泛idea列表。
2. 每个方向给出可证伪假设、最简单基线、价值、风险、需要的外部文献核查。新颖性默认“未建立”，没有搜索记录不能称已查新。
3. 保存实验计划：数据/划分、指标、seed、比较、消融、成功阈值、失败解释、运行代码、时间/输出预算。
4. 用户编辑并批准**当前版本**代码和计划。Agent只有规划工具；没有approve/run工具。
5. 可选可信本地Code Lab：用户点击一次执行一次，先持久化运行身份，再执行，最后保存代码Hash、来源版本、退出码、日志和运行状态。改代码/父地图/资料后旧批准失效。崩溃留下未确认运行，不自动重试。

首版Code Lab是“代码编辑+受限时长输出的真实Python/JavaScript运行”，不是PTY终端、Notebook多内核或GPU调度。默认关闭，必须由本机用户设置明确的信任开关。子进程**不是安全沙箱**，有宿主用户权限；禁用模型自动运行是产品授权边界，不是OS隔离证明。网络、文件系统和进程树的强制隔离留给后续容器/浏览器内核，不能用shell=false/环境过滤冒充。

## 5. 持久对象与失效规则

| 对象 | 必须保存的身份 | 失效或权限规则 |
|---|---|---|
| StudyProject | id,root,revision,manifestVersion | 同一会话不能静默换项目；重索引不改写源文件 |
| SourceSnapshot | sourceId,relativePath,byteHash,textHash | 当前文件变化必须重索引；历史注解仍绑定旧Hash |
| Roadmap | revision,manifestVersion,source anchors,prerequisite DAG | 缺引句、错来源、环依赖直接拒绝；不宣称数学已证真 |
| Note | author(user/agent),source anchor,nodeId,revision | 双方内容分离；模型不能覆盖用户注解 |
| LearningEvent | actor=user,nodeId,attempt,stage | 用户动作不能由模型伪造；不产生伪精确百分数 |
| Proposal | roadmap revision,gap/hypothesis/alternatives,noveltyStatus | 父地图改动后显示陈旧；无检索就不宣称创新 |
| Experiment | plan+code+budget hash,source/roadmap versions | 用户审批精确版本；执行前复核来源；运行授权只能消费一次 |
| RunReceipt | runId,codeHash,planHash,status,stdout/stderr,exit | 成功执行不等于研究主张成立；中断不会自动重放 |
| VisualArtifact | scope,rendererVersion,specHash,dataHash | 只允许当前Study/课程/Assignment读取；固定规格不执行任意代码 |

所有正式状态在现有SQLite连接中操作。修改使用预期revision；不能由多个Host用过期内存状态覆盖数据库。长编译/运行不能占用数据库事务等待；按准备—提交运行身份—异步执行—保存结果分离。

## 6. 共享可视化插件

插件名 `math-visualization`，两种Mode Pack均启用；在两种工作区中打开同一个可视化面板。模型仅提交有上限的规格，Host计算数据，固定前端用本地 `plotly.js-strict-dist-min@4.1.0` 渲染。

首版支持多项式曲线/散点、二维矩阵作用、参数曲面或显式三维散点。每图必须有title、axis labels、purpose及prediction/observation提示。支持缩放/旋转/重置/有限参数编辑，提供文本描述和数据，不能仅靠颜色传达含义。拒绝NaN/Infinity、超大数据、未知字段、HTML/脚本、外链。

共享不意味着跨项目偷读：服务器从当前会话绑定推导scope，不接受浏览器指定任意scope。Course Assignment与课程本身仍隔离。固定脚本放在sandbox iframe中；禁止任意脚本、网络连接、父页面访问。Plotly strict无需eval，但样式CSP需求与WebGL可用性仍要真实浏览器验证。无WebGL时提供明确错误/数据查看，而不是把空白图算成功。

Manim/Mafs/MathBox后续作为独立Renderer适配器，不要把多套运行时一次全装。把固定可视化自动转成课件图片、复杂证明动画、latex PDF导出留到下一切片。

## 7. 分期与通过标准

### F0：研究与契约（本期）
本计划、来源登记、已有组件复用边界、Skills与许可证。通过：所有“采用”可指出具体模块，所有未来功能明确不冒充实现。

### F1：Study基础纵向流程（本期）
实际Host/入口/API/页面/Mode Pack；目录选择、按需来源、阅读地图、节点讲解、双方笔记、数学预览与真实原生Pi会话。通过：含一处错误的测试论文可记录疑点；坏引用/依赖环被拒绝；刷新/重启保留状态；用户笔记不能由Agent改写。

### F2：Research批准与Code Lab（本期）
idea→计划→用户审批→一次真实运行→回执。通过：未批准不可运行；代码、来源、地图变动使旧批准失效；并发双击至多执行一次；超时/输出上限产生明确失败；没有模型run/approve工具。至少Python与JavaScript的用户编辑/执行各一个回归。

### F3：共享可视化地基（本期）
固定spec、物理Pi插件、两个Mode Pack、2D/3D viewer。通过：同一插件在备课与Study激活，离开模式卸载；跨scope拒绝；浏览器看到真实绘制与交互；恶意spec拒绝。

### F4：后续完整学习工作台
PDF坐标高亮与批注编辑、Docling结构提取、细粒度证明义务图、与源代码符号的关联、可配置学习测评、外部文献检索receipt、实验artifact目录与多次run统计、xterm/PTY或JupyterLite、OS隔离和高级可视化适配。必须独立规划，不以地基名义全算完成。

## 8. 验收顺序

先用小目录（Markdown论文、带注释Python、PDF）完成“读一个证明—保存一条疑点—用户写笔记—改一个代码例子并运行—画同概念2D/3D”。然后切到已有真实课程，确认旧备课链未被破坏、共享图可用。最后核验目录越界、symlink、隐藏密钥文件、过期引句、revision冲突、批准重放、代码超时、stdout超限、重启未完成run和模式切换。

测试使用固定faux provider，不消耗真实模型token。模型解释质量/研究方向是否真有价值由真实材料的人类试用验证；自动测试不证明“彻底理解”。

## 9. Sources

### ARIS / Auto-claude-code-research-in-sleep
- 版本：`f1bd907b58f653131ebe6807c482e2554e07f9b9`；许可：MIT。
- https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f1bd907b58f653131ebe6807c482e2554e07f9b9/skills/experiment-plan/SKILL.md
- https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f1bd907b58f653131ebe6807c482e2554e07f9b9/skills/research-refine/SKILL.md
- https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f1bd907b58f653131ebe6807c482e2554e07f9b9/skills/ablation-planner/SKILL.md
- https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f1bd907b58f653131ebe6807c482e2554e07f9b9/skills/proof-checker/SKILL.md
- https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f1bd907b58f653131ebe6807c482e2554e07f9b9/LICENSE

### paper-to-course
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：MIT。
- https://github.com/KaguraTart/paper-to-course/blob/main/README.md
- https://github.com/KaguraTart/paper-to-course/blob/main/SKILL.md

### DeepTutor
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：Apache-2.0。
- https://github.com/HKUDS/DeepTutor/blob/main/README.md

### PaperQA2
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：Apache-2.0。
- https://github.com/Future-House/paper-qa/blob/main/README.md

### Plotly.js strict build
- 版本：`v4.1.0`；许可：MIT。
- https://github.com/plotly/plotly.js/blob/v4.1.0/dist/README.md
- https://github.com/plotly/plotly.js/releases/tag/v4.1.0

### Mafs
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：MIT。
- https://github.com/stevenpetryk/mafs/blob/main/README.md
- https://github.com/stevenpetryk/mafs/blob/main/package.json

### MathBox
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：MIT。
- https://github.com/unconed/mathbox/blob/main/README.md

### Manim Community
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：MIT。
- https://github.com/ManimCommunity/manim/blob/main/README.md

### KaTeX
- 版本：`existing pi_own lockfile`；许可：MIT。
- https://katex.org/docs/security

### W3C Web Annotation / Hypothesis
- 版本：`W3C Recommendation / main inspected 2026-09-11`；许可：W3C specification; Hypothesis BSD-2-Clause (no code copied)。
- https://www.w3.org/TR/annotation-model/
- https://github.com/hypothesis/client/blob/main/README.md

### Docling
- 版本：`main inspected 2026-09-11 (not vendored)`；许可：MIT (models have separate licenses)。
- https://github.com/docling-project/docling/blob/main/README.md

### JupyterLite / Pyodide
- 版本：`stable docs inspected 2026-09-11 (not vendored)`；许可：BSD-3-Clause。
- https://jupyterlite.readthedocs.io/en/latest/howto/content/python.html

