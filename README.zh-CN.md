# dsh-open-file

[English](./README.md) · 简体中文

面向 DeepSeek Harness Web 的工作区文件附件、文档读取、本地 OCR 与页面渲染插件。

`dsh-open-file` 支持把任何格式的文件带入 DeepSeek Harness 会话。随附的 Agent 工具可检查上传内容，并根据任务读取、OCR 或渲染其中可用的信息，形成一套可追溯工作流。

<p align="center">
  <img src="https://raw.githubusercontent.com/Hyp6666/dsh-open-file/main/assets/dsh-open-file-drop.png" width="960" alt="在 DeepSeek Harness Web 中拖放文件">
</p>

<p align="center">
  <strong>拖入文件即可进入会话</strong><br>
  把一个或多个文件拖到 DeepSeek Harness Web 的任意位置，即可添加到当前会话。
</p>

## 功能

- 在现有 `+` 菜单中加入 **添加 → 附件** 操作。
- 通过系统选择器与全页面拖放接收多个文件。
- 使用紧凑草稿卡片展示格式图标、上传进度、取消、重试与移除控件。
- 把已发送附件卡片放在对应用户消息下方，保持会话布局整齐。
- 通过同源二进制流把文件写入当前会话工作区。
- 提供四个 Agent 工具：`file_inspect`、`file_read`、`file_ocr`、`file_render`。
- 读取文本、PDF、DOCX、PPTX、XLSX、受资源边界保护的 ZIP、常见图片格式，以及常规文件元数据。
- 使用随包语言数据执行英文与简体中文 OCR。
- 返回来源哈希、定位信息、游标、解析器与稳定引用，支持可追溯推理。

## 兼容性

| 组件 | 版本或要求 |
| --- | --- |
| DeepSeek Harness | `0.1.0-rc.6` |
| Node.js | `>=22.13.0` |
| 操作系统 | Windows、Linux、macOS |
| 浏览器 API | `fetch`、`XMLHttpRequest`、`File`、拖放 |

Web 集成使用 rc.6 的输入触发器注册、会话渲染器、原生图片流程与客户端运行时 API。主机契约需要关注时，兼容性检查会返回 `FILE_WEB_COMPATIBILITY`。

## 安装

安装最新 npm 版本：

```bash
dsh plugin --profile web add dsh-open-file
```

安装 `0.1.1`：

```bash
dsh plugin --profile web add dsh-open-file@0.1.1
```

安装本地审核包：

```bash
npm ci
npm pack
dsh plugin --profile web add ./dsh-open-file-0.1.1.tgz
```

安装包通过 `cordis.patch.yml` 激活 Host 服务、Web 客户端与 Open File Skill。npm 使用英文 `README.md` 展示包文档。

## 快速使用

1. 打开带有活动工作区的 DeepSeek Harness 会话。
2. 选择 `+` → **添加** → **附件**，也可把一个或多个文件拖入 Web 应用。
3. 查看草稿卡片并等待就绪状态。
4. 发送消息，生成会话绑定的 `dsh-open-file://attachment/v1/...` 引用。
5. Assistant 可根据任务选择检查、读取、OCR、渲染或直接作答。

<p align="center">
  <img src="https://raw.githubusercontent.com/Hyp6666/dsh-open-file/main/assets/dsh-open-file-formats.png" width="960" alt="DeepSeek Harness 输入区中等待发送的多种格式文件">
</p>

<p align="center">
  <strong>任何格式的文件，只要任务需要，都可以上传</strong><br>
  文档、数据、源代码、压缩包、图片与其他格式统一进入附件流程。
</p>

| 工具 | 职责 |
| --- | --- |
| `file_inspect` | 返回元数据、解析器信息与可选择的 `part_ref` |
| `file_read` | 使用文本游标或工作表范围读取选定 part |
| `file_ocr` | 对选定图片 part 执行本地英文与简体中文 OCR |
| `file_render` | 把选定文档 part 渲染为工作区 PNG |

图片文件接入 DSH 图片流程。文档与常规文件使用工作区附件流程。

## 配置

`0.1.1` 使用随包发布默认值。`cordis.patch.yml` 注册 Host 服务、Web 客户端与 Skill。资源边界列于下表，并纳入公开契约。

## 权限、数据位置与上传协议

源文件与派生产物位于当前会话工作区：

```text
<workspace>/.dsh/open-file/v1/sessions/<sha256(session-id)>/
```

插件读写该会话目录，并在 DSH Web Host 注册同源上传路由。OCR 使用随包提供的 `eng` 与 `chi_sim` 语言数据。

```text
POST   /dsh-open-file/v1/uploads/prepare
PUT    /dsh-open-file/v1/uploads/<upload-id>     application/octet-stream
POST   /dsh-open-file/v1/uploads/<upload-id>/commit
DELETE /dsh-open-file/v1/uploads/<upload-id>
```

工具响应包含来源哈希、解析器、定位信息、游标与规范引用。提取出的文件内容会标记为供后续推理使用的非可信证据。

## 默认限制

| 限制 | 默认值 |
| --- | ---: |
| 单文件 | 256 MiB |
| 每会话草稿文件数 | 20 |
| 每会话草稿总量 | 512 MiB |
| ZIP 条目数 | 10,000 |
| 单 ZIP 条目展开大小 | 64 MiB |
| ZIP 总展开大小 | 512 MiB |
| ZIP 压缩比 | 100:1 |
| 上传超时 | 300 秒 |
| 解析与渲染超时 | 30 秒 |
| OCR 超时 | 120 秒 |
| 渲染像素 | 40,000,000 |

这些数值构成 `0.1.1` 的资源边界。

## 安全说明

- 会话引用、活动 Agent 会话、权威工作区与磁盘元数据共同组成校验链。
- 规范路径边界检查与符号链接感知检查保护工作区托管路径。
- ZIP 校验覆盖路径规范化、链接、加密、重复条目、CRC 完整性、归档深度、展开大小与压缩比。
- Office XML 校验覆盖声明、实体与关系目标。
- 类型识别使用文件魔数与容器结构。
- 已发布源文件保持 immutable；派生产物使用独占创建与原子元数据替换。

安全策略与报告流程详见 [SECURITY.md](./SECURITY.md)。

## 常见问题

- **附件入口：**确认 Web 客户端插件处于活动状态，并确认 Host 版本为 DeepSeek Harness `0.1.0-rc.6`。
- **上传：**确认会话状态、工作区权限、同源路由与资源边界。
- **OCR：**选择图片 part 或 `file_render` 生成的 PNG，再选择 `eng`、`chi_sim` 或两种语言。
- **文档解析：**调用 `file_inspect` 查看检测类型、解析器与可用 part。

稳定错误码由包契约导出，并随工具错误返回，供程序化处理。

## 卸载

```bash
dsh plugin --profile web remove dsh-open-file
```

安装指定版本可完成版本切换：

```bash
dsh plugin --profile web add dsh-open-file@0.1.1
```

## 开发与验证

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:release
npm pack
```

发布流程会在 Windows、Linux 与 macOS 上执行类型检查、代码规范检查、完整自动化测试套件、生产构建与 npm 产物检查。

## 发布闸门

维护者批准两份 README 与生成的 tarball 后，GitHub 与 npm 发布流程即可开始。最终验收覆盖安装包、Web 启动、文件选择、拖放、上传、消息渲染、四个工具、草稿控件与插件移除。

## 许可证

[MIT](./LICENSE)
