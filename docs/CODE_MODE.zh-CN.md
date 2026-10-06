# Code Mode（便携 Mode Package）

Code Mode 使用与通用 Mode Pack 相同的不可变 `ResourceSnapshot` 绑定。每个绑定带有
`packageContentHash`；恢复会读取该精确包，而显式重新激活才会采用当前内置包或导入包的
新版本。因此，旧会话可以继续使用其已验证的资源，升级不会悄悄改变历史会话。

Mode 按对话绑定，可在两个浏览器标签页同时打开不同对话并使用不同模式。
切换一条对话不会改变另一条对话的模型、提示词、Skills 或工具。新对话入口仍在
Pi 原生侧栏顶部；“新建此模式对话”继承当前模式和个人设置。

首次激活新版 Code 会安装其所选精确依赖，此阶段受网络与磁盘速度影响；后续激活
复用已验证的运行时。Host 复用 SDK 加载器代码和按源码哈希缓存的转换结果，每条
对话仍创建独立扩展模块、运行时和事件总线。模式栏显示正在切换的目标，失败保留
原模式并显示错误；服务日志记录请求的 session/mode、依赖安装、验证及失败耗时。

快照还会保存所选定修订的默认系统提示语哈希。所以显式激活或 reload 会在同一
`packageContentHash` 的新定义间正确更新未编辑的默认提示语，而保留用户自定义提示语。模型、thinking、工具或 Skill
的普通会话设置修订始终继续绑定已提交的定义，不会采纳导入的同 ID 新修订。缺少这个元数据的旧 JSONL 保留旧兼容判断，不会把当前文本猜成默认值。

若已提交的便携快照资源发生漂移（例如 Spec Kit 模板被改写），普通设置修订会报错，不会从最新同 ID 定义重建运行时。请显式 reload 或激活该 Mode Pack；这是更新定义、模板和可选依赖的唯一途径。

## 包、来源与运行时

### Coding 模式与 Pi Codemode 的区别

Pi 原生 `codemode` 是工具执行方式：模型写 JavaScript 调用已有工具，可并行执行独立
操作，并在脚本内筛选结果；只有脚本输出进入模型上下文。普通工具调用则把每次调用的
结果直接返回模型。Codemode 不切换模型，也不额外授予文件或终端权限，仍受原工具的
权限与当前模式能力边界约束。

Pi-own 的 Coding 模式是任务配置，包含提示词、Skills、LSP、权限和工作区历史等扩展。
内置的工具模式默认开启原生 Codemode，独立的 `tool_search` 默认关闭；纯对话不开启它们。
在“设置 → 常规 → 工具能力”中可分别调整，设置按当前对话和模式保存；模式包编辑器
可调整新对话的默认选择。原始工具预设切换会保留这两个独立开关。已绑定的旧快照继续
保留原选择，显式修改设置或重新激活才采用新的选择。
未绑定模式包的普通对话也可使用同一设置入口，不需要先切换模式。

Pi 1.0 原生内置 MCP。MCP 负责连接服务器，Codemode 负责用脚本调用工具，二者可以同时
开启，也可以独立使用。不新增 MCP 适配器，不因为切换 Codemode 而改变服务器配置。
Codemode 脚本内的 `searchTools()` 也不需要开启独立的 `tool_search`。
若某台 MCP 服务器配置为 `codemode` exposure，其工具通过脚本调用；需要直接调用时
使用该服务器的 `direct` exposure。`deferred` 和 `hidden` 同样保留 Pi 原生语义，Host
不会自动把它们升级为直接工具。学习活动与 Study & Research 只编排该活动已允许的
Host 工具，脚本仍经过资料和权限核验，不载入环境中的 MCP 或额外模型 API。
Pi 1.0 缩短了 Codemode 的工具声明和提示词，并改进错误恢复提示；并行与结果筛选
可以减少往返和上下文，但不保证每个简单任务都更快或更省 token。

四个宿主 Pi 核心包当前同步固定为 `1.0.0`。设置中的 Pi 更新入口检查官方稳定版，
以 `--ignore-scripts` 安装同一精确版本，并同步重建内置 Coding 包。安装完成后需重启
Pi Web 才能使用新宿主 SDK；已绑定的旧便携包保留精确资源，显式重新激活可采用新版。

内置 Code 包在打包时由 `scripts/build-portable-code-mode-archive.mjs` 生成到
`apps/pi-web/runtime/mode-packs/coding.archive.json`。运行时只解析该自包含 JSON，绝不
回读仓库、`third_party` 或原始 Skill 目录。`npm run dev` / `npm run dev:lan` 会通过
`predev` 钩子生成它；在直接运行应用 TypeScript 检查前，先执行：

```powershell
node scripts/build-portable-code-mode-archive.mjs
npx tsc --noEmit -p apps/pi-web/tsconfig.json
```

`npm run build` 的 Study runtime staging 同样在原子发布前生成该资产，避免 Study 预构建
覆盖 Code 包。

Pi Web 的 `postbuild` 会逐份检查 Next 服务端文件追踪：任何路由超过 20,000 个文件，
或把 Windows 构建机的用户目录纳入产物，都会直接失败。此前静态解析
`resolve(tmpdir())` 与 `resolve(homedir(), 用户路径)` 曾分别追踪整个 Temp 与用户目录；
现在这些路径只在请求运行时解析，防止构建内存和产物被宿主文件放大。

包内 `provenance/.skills-lock.json` 固定每个逻辑 Skill/扩展的资源 ID、内容哈希、上游
仓库、提交或版本、许可证和源路径。完整的原始来源清单与第三方通知仍在
`third_party/code-mode-sources.json`、`third_party/code-mode-packages.json` 和
`third_party/CODE_MODE_NOTICES.md`。不修改这些原始上游 Skill 文件。

选中的 npm 资源安装到 Pi agent 目录的
`mode-packs/r/<dependency-and-platform-hash>/node_modules`。安装使用精确版本与 SRI，
忽略 npm scripts，不修改全局 PATH、全局 npm 配置或其他 Mode 的缓存。缓存标记覆盖完整
已安装树；被改写的源码会触发验证失败和私有重建。未选择的可选资源不会安装。npm 的
`.bin` 安全内部链接被纳入完整树身份；逃出 `node_modules` 或形成目录循环的链接会被拒绝。
扩展产生的可变文件不能写回这棵不可变目录。`pi-permission-system` 的配置与日志按包运行时
身份保存在 `mode-packs/state/mode-<profile-hash>/pi-permission-system/`，前台与后台子代理通过
各自模块内的私有环境继承相同路径，不修改宿主进程的全局环境。

内置包的已使用哈希保存在 agent 目录 `mode-packs/builtin-packages.json`。这是一个显式的
历史登记表，不扫描缓存目录；仅已绑定 Coding 快照可进行旧登记表迁移。损坏或孤立目录
不能成为可信包。

默认 Code 启用六个原生 Skill（包含 `grill-with-docs`）；`test-driven-development` 留在包内供按需选择，默认不加载。宿主按当前选择装入 Pi 原生 Codemode 和独立工具搜索；原生 MCP 在普通工具模式中按自身配置连接。默认还启用四个必需扩展以及推荐但可关闭的
`pi-workspace-history`。Skill 使用 `grill-me`、`incremental-implementation` 这样的通用逻辑
ID；模式边界由当前 Mode Pack 选择提供，不再把 `code.` 写进 Skill 名称。Playwright CLI 等可选能力只有在其资源被选择后才安装。私有
TypeScript language server、Playwright CLI 和兼容旧配置的 Chrome DevTools MCP 通过每次命令的私有
运行时路径启动。Pi 原生 MCP 按有效 Pi agent 目录中的 `mcp.json` 与受信任项目的 `.pi/mcp.json` 加载；未设置自定义 agent 目录时才使用 `~/.pi/agent`。默认 `codemode` exposure 不把整套工具声明直接塞进模型上下文。
六个默认 Skill 均是“默认启用”，不是“必需”：当前模式设置可取消勾选；模式包编辑器可以将其从新修订中移除，并在导出时去掉不再被引用的 Skill 目录。

要改变插件或 `pi-workspace-history` 的默认选择，直接编辑当前 Code 模式包并激活保存后的修订；
它们不是可用会话 Skill 设置单独开关的项目。

`@ff-labs/pi-fff@0.11.0` 是 Pi Web 宿主的通用搜索扩展，不属于 Code 包。任何允许
`grep` 或 `find` 的模式都通过它的 `override` 模式使用同一套 FFF 搜索；索引和历史数据库
保存在 agent 目录 `fff/`，不写入 Mode Package 的只读 npm 运行时。模式包仍独立选择自身的
Skill 与插件。包内 Skill 也列在完整 Skill 库，保留原名；编辑器可取消默认启用、解绑，或
从另一个已安装包选择资源并组装成新的便携包。
插件页分开显示宿主通用扩展、模式包扩展和 Pi 全局/项目包。模式包列表显示当前定义的选用状态；
这不等于会话已加载，后者以模式会话的运行时验证为准。宿主通用扩展显示本地依赖安装状态。
取消默认启用会保留组件的版本与字节，方便以后重新启用；“从此模式包移除”则从当前组件图和导出包中移除该 Skill 的文件。内置模式沿用原 ID 原地保存，存储中只保留一个当前定义；旧会话绑定的内容哈希包仍可供历史快照读取。使用“保存并启用”可立即切换到新定义。
导入后的多阶段模块按整个模块保存修订：编辑一个阶段时，其余阶段同步推进版本并保留各自的资源选择。

## 扩展与子代理隔离

Windows 的工作区快照 Git 命令由 Host 加入 `-c core.longpaths=true`，不修改系统或用户
Git 配置。快照以会话 cwd 为根，读取该目录的 `.gitignore`；子目录工作区不会自动继承
仓库上层的忽略规则。Pi Web 目录同步排除 `.artifacts`、`.pi`、课件输出和诊断日志。
扩展失败会带 session、扩展路径、事件与完整错误写入服务器日志，并照常通知前端。

### 权限配置

Pi Web 左下角 **设置 → 权限** 提供“操作前询问”“允许常规读取”“允许自主工作”三种
策略、独立的外部目录访问开关和 JSONC 高级规则。可以保存全局默认或当前 cwd 的项目
覆盖，页面显示实际权限插件是否已加载。保存以内容哈希检查并发变化，再原子写入；
规则由上游权限引擎在后续工具调用中按文件变化重新读取，不重启正在运行的 Agent。
切换预设保留明确 deny 规则。非法配置拒绝保存，不静默退回默认。

对话输入 `/permission-system` 仍可打开权限插件的 YOLO 与调试开关。精细规则写在
Pi agent 根目录的 `pi-permissions.jsonc`，随 `PI_CODING_AGENT_DIR`，项目规则则在
`<当前 cwd>/.pi/agent/pi-permissions.jsonc`。规则值为 `allow`、`ask`、`deny`。
当前没有规则文件时所有类别默认 `ask`。示例仅供用户自行选择，不自动授予权限：

```jsonc
{
  "tools": { "read": "allow", "grep": "allow", "find": "allow", "ls": "allow" }
}
```

外部目录还需要 `special` 类别的单独授权；工具允许不覆盖外部目录检查。
Windows 原生终端工具叫 `powershell`，可在 `tools` 里配置；`bash` 命令规则只对应
Bash。弹窗中的 `Allow Always` 仅保存本会话的匹配目标，不写入规则文件，读取不同
目标仍可能询问。全局 `deny` 不会被项目规则或 YOLO 放开。

上游权限、LSP 和子代理扩展保持原始字节。Code 运行时仅对已固定版本的确切入口使用宿主
适配器：权限叶模块拥有每会话词法状态，LSP 只清理其工厂同步注册的监听器，子代理继承
父会话能力上限和权限转发。普通 General、Study、Education 会话不会读取未选中的 Code
包字节或共享这些状态。权限策略在 `before_agent_start` 缩小工具集后，验证以实际授权后的
工具集为准，不会为“通过验证”重新开放被拒绝的工具。

在 Windows 和宿主固定的 `pi-subagents@0.74.0` 上，分离子代理 runner 会用私有 Jiti bootstrap
替换其成功路径的强制 `process.exit(0)` 为 `process.exitCode = 0`，让 Node 24 在 fetch/扩展
清理后自然排空事件循环，避免已知的 `UV_HANDLE_CLOSING` 断言。失败路径仍保留上游非零
退出；该适配只作用于子进程中经验证的 runner 源形状，既不改写上游文件，也不修改宿主
进程的 `process`。

Windows 上 TypeScript LSP 的 `path:*` 工作区诊断已验证。上游 per-file URI 仍可能遇到
`file:///G:/` 与 percent-encoded drive URI 的兼容问题；不要把单文件 URI 无错误作为当前
保证。

## 前端和 Spec Kit

包前端声明原始入口和全部哈希资产。它在 opaque sandbox iframe 中运行，以
session、snapshot、nonce 和来源校验的握手获得受限能力。资源快照或包变更会旋转上下文；
旧异步消息会被丢弃。前端静态 GET 仅允许已验证的当前包资产，并以 CSP sandbox 响应，
直接打开 HTML/SVG 也不会获得宿主 origin。无前端包不显示面板。

`projectCapabilities: ["spec-kit"]` 是能力而非 Code ID。官方 Spec Kit 提示模板以哈希
native prompt-template 资源进入快照；状态会报告漂移，显式刷新才更新。初始化始终显式，
使用 `uvx specify-cli==1.0.5 --integration pi --script ps`（Windows），并在同一会话转换锁
内运行；部分安装、并发或过期快照会明确失败而不会伪造可初始化状态。

## 导入、导出与操作

激活带前端的包后，Mode Pack 覆盖层会显示 **Open mode panel**；没有 `frontend` 描述符的包
不会显示此入口。面板不是模型工具，也不能读写任意宿主 API。导出与导入使用
`GET` / `POST /api/mode-packs/portable`：默认使用流式 `.mode-pack.tar`，首项是严格验证的
通用 manifest，其后为全部本地文件及离线 npm 运行时；仍可读取旧版 JSON 包。导入后的 ID
必须以 `custom.` 开头。导入不会自动激活，也不会把未选择的可选依赖带入当前会话。

验证覆盖包路径规范化、哈希、缓存源码篡改、npm SRI/入口、可选依赖选择、同一资源 ID 的
不同包隔离、恢复与显式升级、前端 nonce/快照轮换及 Spec Kit 并发初始化。它不保证任意
第三方 LSP 的所有 URI 形式，也不把上游 Skill 的文字方法论视为宿主产品保证。

## 内置固定版本与默认选择

所有完整 SRI、tarball、上游仓库和许可证以 `third_party/code-mode-packages.json` 为准；下表是
当前包的可读索引。`必需` 是当前 Code 定义的约束；直接编辑当前模式包可调整其组件绑定。
`推荐` 和 `可选` 同样可在编辑器中调整，其中 `可选` 默认不安装。

| 资源 | 固定版本 | 默认状态 |
| --- | --- | --- |
| `pi-lsp-extension` | 1.3.0 | 必需 |
| `pi-permission-system` | 0.8.0 | 必需 |
| `pi-subagents` | 0.74.0 | 宿主基底，默认启用；Code 包不再重复安装 |
| `pi-web-access` | 0.30.0 | 必需 |
| `pi-workspace-history` | 0.4.3 | 推荐 |
| `typescript-language-server` / `typescript` | 5.0.0 / 5.9.3 | LSP 被选择时的私有运行时依赖 |
| `@playwright/cli` | 0.1.21 | Playwright Skill 被选择时的可选运行时依赖 |
| Pi 原生 Codemode / MCP / tool-search | 1.0.0 | 独立能力；内置工具模式默认开启 Codemode，独立工具搜索默认关闭；MCP 使用自身服务器配置 |
| `pi-mcp-adapter` / `chrome-devtools-mcp` | 2.34.0 / 1.9.0 | 兼容旧配置的可选扩展；新配置优先使用 Pi 原生 MCP |
| `@earendil-works/pi-coding-agent` | 1.0.0 | 子代理被选择时的私有 peer 依赖 |

其他语言服务器仍使用上游扩展自己的 `/lsp-config` 命令和项目配置；当前随 Code 包验证的是
私有 TypeScript 服务器启动与工作区 `path:*` 诊断。为其他语言添加服务器时，必须把精确
运行时来源、版本、完整性与资源选择写入包：若该服务器通过 npm 分发，则这包括 npm pin、
SRI 和入口；不能依赖机器上的全局语言服务器。
