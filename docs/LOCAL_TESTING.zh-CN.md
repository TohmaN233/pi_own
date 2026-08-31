# Learning Harness 本地测试（Windows）

当前可用的是首个持久化纵向切片，不是完整 V1。它可以导入课程、把课程绑定到**新建** Pi 会话、在当前课程内检索来源并点击引用。Pi JSONL 仍是对话记录的唯一权威；Harness SQLite 保存课程、绑定、快照和学习状态。

## 一键启动

双击仓库根目录的 `start-learning-harness.bat`。也可以在 PowerShell 中执行：

```powershell
.\start-learning-harness.ps1
```

脚本以自身所在目录定位 `apps/pi-web`，要求 Node.js `>= 22.19`。若 `apps/pi-web/node_modules/next/dist/bin/next` 不存在，它才会执行 `npm ci --ignore-scripts` 安装 Pi Web 依赖。

PDF 提取器按以下顺序解析：

1. `PI_PDFTOTEXT_PATH` 环境变量指定的文件；
2. `PATH` 中的 `pdftotext`；
3. `C:\texlive\2020\bin\win32\pdftotext.exe`。

三者都不存在时脚本会明确失败，不会启动一个无法导入 PDF 的服务。`-CheckOnly` 只检查 Node、依赖和 PDF 提取器；`-NoOpen` 启动后不自动打开浏览器：

```powershell
.\start-learning-harness.ps1 -CheckOnly
.\start-learning-harness.ps1 -NoOpen
```

若要直接导入/复用 `G:\Baiduyun\S4CI3 F2022 Lecture Notes.zip`、播种两道本地练习并打开一个已绑定会话，双击 `start-learning-harness-demo.bat`。它只在根目录 `scripts/fixtures` 读取私有答案；Pi Web 和普通 HTTP API 不导入这些内容。也可执行：

```powershell
.\start-learning-harness.ps1 -Demo
```

脚本使用 `127.0.0.1:30141`。该端口上已有健康 Harness 时会提示并退出（正常启动时打开浏览器）；端口被其他服务占用时会失败，避免连接到错误服务。正常启动后，PowerShell 窗口保持前台运行；关闭该进程即可停止开发服务。

启动器不会修改用户全局配置。若未显式设置 `PI_LEARNING_HARNESS_DIR`，它只为这次本地测试把该变量设为仓库内的 `.learning-harness-data` 并创建目录；该目录已被 Git 忽略。它也会把本次进程的 `PI_CODING_AGENT_DIR` 指向该目录下的 `pi-agent`（或使用你已设置的目录），使 Demo JSONL 与 Pi Web 使用同一个本地会话目录。启动日志会打印实际使用的 Harness 与 Pi agent directory。

## 手工验证路径

1. 双击 `start-learning-harness.bat`，浏览器打开 `http://127.0.0.1:30141`。
2. 在 **Import** 中导入 `G:\Baiduyun\S4CI3 F2022 Lecture Notes.zip`。
3. Course ID 建议填写 `s4ci3-f2022`，完成导入。
4. 新建一个 Pi 会话并选择该课程。课程选择只作用于**之后新建**的会话；已有会话不会被重新绑定。
5. 在 **Sources** 中输入课程内的术语检索，打开结果并点击引用，确认来源内容和课程范围正确。
6. 点击 **Practice**，选择练习，提交至少三字符的具体推理，再按需逐级显示 Hint。满足门槛后可以点击一次 **Reveal solution once**；关闭面板或刷新页面会丢弃浏览器内存中的答案，服务端 Capability 也已经消费。
7. 在已绑定会话顶部的 **Mode Pack** 中切换 Tutor、Practice 和 Teach-back，然后打开 **Snapshot**。切换会保留同一个 Pi session 和 JSONL，并在 Inspector 中显示 Mode Pack、Runtime envelope、Snapshot hash、Binding revision、实际工具和精确资源清单。
8. 打开 **Modes**，以 `custom.` 开头填写 ID，选择 Tutor / Practice / Teach-back workflow、固定提示词和可选 Skills，点击 **Compile and activate**。刷新或重启后确认自定义 Mode Pack 仍在下拉框和 Snapshot history 中。`visual-lab`、`teacher-prep`、`coding`、`creative` 和 `general` 会显示缺少运行时或需要 hard transition 的原因，不会伪装成已安装。

若要验证跨课程隔离，可导入第二门课程，分别为两门课程新建会话；当前会话的 Sources 只能返回其绑定课程的 span，伪造的跨课程引用会被拒绝。

## 当前可测范围

- ZIP、Markdown、文本、代码、Notebook 和 PDF 课程导入；PDF 输入、stdout、stderr、超时、提取文本、课程文本和 span 数量都有明确预算。
- SQLite/WAL 持久化课程、内容寻址源字节、会话课程绑定、资源快照、学习事件和当前课程检索；重启后可恢复已提交状态。
- 当前课程检索、可点击来源、跨课程引用拒绝，以及 Pi JSONL 分支/克隆/导航后的受限恢复。
- 绑定会话中的练习列表、Start、Meaningful Attempt、Feedback、Hint、一次性 Solution Reveal；公开 Assessment 状态和私有题解分表持久化，重启后不会重置已消费 Capability。
- Tutor / Practice / Teach-back / 自定义 learner Mode Pack 的同会话切换；每次激活都使用不可变 Resource Snapshot 固定提示词、Skill、plugin 和 workflow 身份。学生学习模式仅激活内部的 publication submit 工具，练习模式没有 Pi coding tool，练习能力由 Practice UI 提供。普通未绑定 Pi 会话不受此配置影响。

## 明确未完成项

- Teach-back 的完整自由文本状态机、跨课概念遭遇史，以及模型回答的语义蕴含审查。
- 完整 Rubric、练习作者/教师授权流程、针对 Prompt Injection 与直接工具调用的攻击测试，以及浏览器级 Practice E2E。
- Visual Stage/隔离执行器、可交互数学验证、全局跨会话自定义 Mode Pack 库，以及 Coding/Creative/Teacher 的 hard transition。
- Teacher Studio UI、物理教师构建拆分和发布流程。
- 规范化 FTS/文件源存储、精确 PDF 页码锚点，以及浏览器级崩溃/重连端到端测试。
