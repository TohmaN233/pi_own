# Study 来源读取适配器

`apps/pi-web/lib/study-source-reader.ts` 提供一个只读、有限额的论文来源读取适配器。它只接收调用方明确选择的目录，不访问数据库、不启动 Agent、不执行 TeX，也不会写入来源文件。适配器适合在服务端由已经完成项目/目录授权的 Host 调用；`rootPath` 是本机绝对路径，不能直接暴露给浏览器。

## API

```ts
readStudySources(rootPath: string, options?: StudySourceReaderOptions): Promise<StudySourceManifest>
readStudySource(rootPath: string, options?: StudySourceReaderOptions): Promise<StudySourceManifest>
```

`readStudySource` 是同一个函数的单数别名。建议总是传 `entryPath`，这样不会扫描目录中与论文无关的代码和数据。`entryPath` 可以是 `rootPath` 下的相对路径，也可以是位于该目录内的绝对路径；目录本身必须存在且为目录。

返回值的关键字段如下：

| 字段 | 含义 |
| --- | --- |
| `kind`, `path`, `hash`, `bytes` | 所选主来源的类型、相对路径、原始字节 SHA-256（64 位小写 hex）和字节数 |
| `chunks` | 所有纳入来源的稳定分块，包含 `location`、`hash` 和 `provenance`；TeX 默认每块最多 80 行且 16 KiB |
| `documents` | 每个实际读取文件的快照和分块；`role` 为 `primary`、`tex-include` 或 `linked-pdf` |
| `diagnostics` | 版本关系、公式不确定性、缺失 include 和边界问题等可追踪信息 |
| `dependencies` | TeX include 或同名 PDF 的关系、状态、hash、字节数和调用位置 |
| `mode` | 有 TeX/Word 主来源时为 `source-first`；显式选择 PDF 时为 `pdf-only` |

每个 `StudySourceChunk` 都有：

```ts
{
  id: string,
  kind: "tex-source" | "pdf-page" | "docx-paragraph",
  path: string,
  hash: string,
  text: string,
  location: { kind: "tex-lines", startLine, endLine, ... }
           | { kind: "pdf-page", page, ... }
           | { kind: "docx-paragraph", paragraph, ... },
  provenance: StudySourceProvenance,
  sourceXml: string | null,
  math: readonly { format: "omml", xml: string }[]
}
```

返回对象及其嵌套数组、分块、诊断、来源关系均递归冻结。调用方不能通过返回值修改一次读取的快照。来源文件随后发生变化时，下一次读取会产生新的 hash；读取期间发现 `size`、时间、文件标识或实际字节数变化则抛出 `SOURCE_CHANGED_WHILE_READING`。

## 选择与版本关系

没有传 `entryPath` 时只检查根目录的直接文件，并按以下优先级选择：`main.tex`、`main.docx`、排序后的其他 `.tex`/`.docx`、`main.pdf`、排序后的其他 `.pdf`。嵌套目录应使用 `entryPath`。显式选择 `.pdf` 会保持 `pdf-only`，即使旁边有 TeX 或 Word；显式选择源文件时，会尝试读取同目录同名的 `.pdf` 作为 `linked-pdf`。

同名只表示待核对的链接。适配器不会从文件名、hash 或成功提取文本推断源文件和 PDF 是同一版本，源优先读取会产生 `LINKED_PDF_VERSION_UNVERIFIED`。PDF 的 `PDF_TEXT_MATH_UNVERIFIED` 诊断始终带 `requiresPdfInspection: true`：`pdftotext` 的文本层可按页定位，但上下标、矩阵、分式和其他数学符号仍需查看原始 PDF 页面，提取成功不等于公式正确。

## 三种来源

### TeX

TeX 以严格 UTF-8 解码，保留原始文本和换行，不运行编译器、宏展开器或任何 TeX 命令。每个文件产生按原始行顺序排列的 `tex-source` 分块，默认每块最多 80 行和 16 KiB；把这些分块的 `text` 连接起来即可恢复文件的精确源文本，公式、宏和交叉引用仍是原始源文本。超过单行字节限额时会按 UTF-8 码点拆分，并保留该行的位置。

只解析注释之外的字面 `\\input{...}` 和 `\\include{...}`。路径为有限长度的字面相对路径时，先尝试原名，再尝试追加 `.tex`；解析结果必须经过 lexical path 和 `realpath` 两层根目录检查。缺失目标、越界目标、循环、非字面目标和最大深度都会在包含文件的行上写入诊断，并且不会读取根目录以外的文件。

### PDF

PDF 使用现有的 `packages/course-host` `PdftotextExtractor`。默认命令来自 `PI_PDFTOTEXT_PATH`，其次为 `pdftotext`；测试或可信 Host 可以通过 `pdfExtractor` 注入同一接口的有限实现。提取结果按 form-feed 分页，分块位置为 1 起始的 `pdf-page`。文本层为空时仍保留第 1 页分块并增加原页检查诊断。

### Word `.docx`

适配器只读取 ZIP 内的 `word/document.xml`，使用仓库已有的 `jszip`，并限制 ZIP 条目数和解压后的 XML 字节数。每个 Word 段落保留段落原 XML 到 `sourceXml`；其中的 OMML `<m:oMath>`/`<m:oMathPara>` 片段按原字符串保留在 `math[].xml`，不会被 Mammoth 式纯文本提取悄悄压平。段落文字只来自 Word 文本节点，公式文本不会冒充已解析的数学语义。

旧 `.doc` 明确抛出 `LEGACY_DOC_UNSUPPORTED`，不会尝试用未知编码读取或静默产生乱码。TeX 和 `document.xml` 的未知/非 UTF-8 编码抛出 `UNKNOWN_ENCODING`。

## 边界与错误

默认限制是：最多 128 个真实文件、根目录下最多 512 个目录条目、相对根最多 12 层、每文件 32 MiB、所有原始文件合计 64 MiB、提取输出 32 MiB、TeX 每块 80 行/16 KiB、DOCX 最多 512 个 ZIP 条目。可通过 `options.limits` 收紧。`maxDepth: 0` 表示只允许根目录直接文件。达到限制时抛出 `StudySourceLimitError`，其 `code` 会指明 `MAX_FILES`、`MAX_DEPTH`、`MAX_TOTAL_BYTES`、`MAX_FILE_BYTES`、`MAX_OUTPUT_BYTES`、`MAX_DIRECTORY_ENTRIES` 或 `MAX_ARCHIVE_ENTRIES`。PDF 以页分块，单页可能大于 TeX 块大小，但仍受 `maxOutputBytes` 的明确上限；Word 段落 XML 同样计入输出上限，超长段落不会被静默截断。

显式入口和每个 TeX 依赖都先经过词法根目录检查，再经过 `realpath` 检查；指向根外的 symlink 不会被读取。显式入口越界抛出 `SOURCE_OUTSIDE_ROOT`。解析层面的缺失 include、循环和 PDF 公式不确定性保留在 `diagnostics`，供 Host 决定是否阻断后续学习。

## 实际验收证据

定向测试：

```powershell
cd <repo>\apps\pi-web
node --experimental-strip-types --test lib/study-source-reader.test.mjs
```

该测试覆盖 TeX include、循环和越界，PDF 页定位与数学不确定性，带 OMML 的合成 `.docx`，ZIP/文件/输出边界，未知编码，hash 变化和 `.doc` 拒绝。可选的真实资料 smoke 只在显式设置 `PI_STUDY_SOURCE_SMOKE_ROOT` 时运行；目录必须包含 `main.tex` 与 `main.pdf`，测试只验证只读解析、字节数和定位信息，不在仓库记录资料内容、路径或 hash。

适配器不会编译 TeX、做 OCR、解析 OMML 的数学语义、判断 PDF 与源文件是否同版，也不把文本层成功当作学术正确性证明。这些能力应由后续 Host/学习流程在保留上述来源 hash 和位置的基础上明确接入。
