# 更新日志

本文件记录 cortico-world-qq-final 每个版本的改动，供扩展市场的「更新说明」直接读取。

规则：每版本一个二级标题，标题里的第一个版本号即为本节版本。

## 0.4.0

安全整改（响应认证评审 Pal-AI-Lab/cortico-extensions#104），四项均为**破坏性变更**，升级后需检查配置。

### 密钥一律走框架 `ctx.secret()`，不再自行读部署文件

- 删除 `resolveSecret` 里的目录扫描逻辑：不再从 `dataDir` 往上推算、读取部署 `config.json` 与 `providers/*/config.json`、也不再用自复制的正则解析各 provider 的 `.env`。这既绕开了框架「密钥按部署隔离、provider 密钥只交给 provider」的安全措施，自复制的正则还踩过「`NAME=` 留空会读到下一行」的坑（Cortico#268）——空值行会把下一个密钥整行当成 Bearer 发出去。
- 密钥统一经 `WorldContext.secret(name)` 解析（读部署 `.env`，解析规则随框架修复）。涉及：辅助视觉、表情包标注、主动说话、动态生成、情绪感知、语音判定/合成/ASR 全部密钥。

### 辅助 AI 任务改为纯配置驱动，不再跟随主模型密钥

- 删除 `detectActiveProvider()` 与 `autoEndpoint`/`autoApiKey`/`autoModel` 三个缓存字段。曾经的「配置留空 = 自动跟随部署主模型」已移除：那需要自行读部署配置与 provider 目录，且存在「地址填了、密钥名留空时把主模型密钥发到用户所填地址」的隐患。
- `resolveHelperModel()` 改为逐项检查：**模型地址 / 密钥名 / 模型名三项必填**，缺任一项返回失败并给出可操作的提示（写清缺哪项、密钥该写什么名字、值放哪），绝不借用别的密钥、绝不静默重试。
- `vision` / `proactive` / `qzone` / `emotion` 四段的配置描述同步更新：密钥只写名字，值放在部署密钥库（`.env`）里由框架读取。
- `emotion.enabled` 默认由 `true` 改为 `false`：情绪感知每条消息都会额外调一次模型，与主模型的工作重复；真需要时填好三项再开。

### 去掉与其他 World 的桥接（qq_note_*）

- `notebook.ts` 删除经 `globalThis` 桥接 `cortico-world-memory` 的逻辑，只写本地 `dataDir/notebook.jsonl`。`qq_note_*` 与记忆扩展自带的 `mem_note`/`mem_notes`/`mem_forget_note` 功能重复，两个都装时模型应优先用后者（常驻环境提示词 + 混合检索）；工具描述里已写明。
- 本扩展不 import、不探测、不调用任何其他 World。

### 自有模型调用上报用量

- `completeChat`（主动说话/动态/情绪）、辅助视觉 `describe`、表情包标注 `annotate` 三处自有模型调用，成功后经 `host.reportUsage()` 上报，用户可在控制台看到用量。

### 其他

- `qzone.ts` 删除未使用的 `resolveSecret` 选项。
- `vision.enabled` 描述补充其与默认开启的「图片作为模型附件」的关系（两条看图的路，不建议同开）；README 同步说明。
- README 修正多处与代码不一致：`wsHost`/`wsPath` 默认值、`token` 自动生成说明、`privateAggregationWindow` 默认 0、`emotion.enabled` 默认值、`qq_send` 发送语义、工具清单补齐 `qq_reminder_*` 三项、配置项全部对齐源码。

## 0.3.8

修复 0.3.7 的自动探测路径层级错误。

- `detectActiveProvider()` 把**部署配置**和 **provider 目录**按同一层级去找了：两者都按「`dataDir` 往上两级」计算，于是部署配置被找成 `<DATA>/home/config.json`（实际在 `<DATA>/home/companion/config.json`）→探测静默失败 → 四个辅助 AI 任务全部报「未能自动确定要用的模型」。
- 正确层级：`dataDir = <DATA>/home/companion/data`，**上一级**是 `companion`（部署配置在这），**上两级**是 `home`（各 provider 目录在这）。现按这两个层级分别取。
- 新增回归测试锁住该路径推导，避免再犯。

## 0.3.7

辅助 AI 任务改为**默认跟随主模型**，做到零配置。

起因：装桌宠时用户配好的是自己的模型（如 DeepSeek），但「主动说话 / QQ空间动态 / 情绪感知 / 辅助视觉」这四项任务各自写死了 OpenRouter，于是装完一开主动说话就刷「缺少 API Key」——默认值让人先失败一次很不友好。更糟的是四处默认值本就不一致（视觉/主动/动态指向 OpenRouter，情绪指向 DeepSeek），且 `endpoint` 与 `apiKeySecret` 压根没注册到配置面板，用户无法自行修改。

改动：

- `vision` / `proactive` / `qzone` / `emotion` 四段的 `endpoint`、`apiKeySecret`、`model` **默认值改为空串**，含义是「自动跟随部署里当前启用的主模型」。
- 新增 `QQWorld.resolveHelperModel()`：逐项判断——填了就用填的，没填就从 `config.json` 的 `activeProvider` 取 `baseUrl` / `secret` / 模型名，密钥交给既有的 `resolveSecret`（进程环境变量 → provider 目录下的 .env）。
- 新增 `QQWorld.detectActiveProvider()`，在 `start()` 里探测一次并记入日志（含实际使用的 provider、模型与地址），便于用户确认「到底在用哪个模型」。
- 显式填了密钥名但找不到时，告警会直接给出可操作的下一步（去哪个 .env 写什么，或留空以跟随主模型），不再只丢一个名字。
- 四段的 `endpoint` / `apiKeySecret` **注册到配置面板**（各段新增「模型地址」「密钥名」两项），用户可在界面自行指定；`model` 字段描述补充「留空=跟随主模型」。
- `Vision` 接受注入的模型解析器，复用同一套逻辑；此前它只查 `process.env`，拿不到 provider 目录下的 .env 密钥。
- 回归测试：新增「四项任务默认留空」与「normalizeConfig 不会把留空字段回填成默认值」两条，防止以后又被写死。

升级后**什么都不用配**即可使用主动说话等四项功能；若想单独指定某个 OpenAI 兼容服务，在对应面板填「模型地址 / 密钥名 / 模型名」即可。

## 0.3.6

修正连接相关提示文案——0.3.0 起反向连接已强制带鉴权 Token，但界面与文档里还残留着「反向不用填 Token」的旧说法，会让人漏配而连不上。

- **「连接与监听」面板**：删掉「OneBot Token 留空即可」的说法，改为「Token 必填」。原先的提示框只有一行灰字，现在把三步流程做成醒目卡片（红框）：① 在协议端打开「设置反向客户端」② 粘贴 Token ③ **点「保存连接」**，并注明「填完不保存 → 协议端不重连 → 桌宠一直显示未连接，尽管 Token 明明填对了」。
- **配置项说明**：`token` 字段改为「【反向连接必填】…就显示在下方输入框里，整串复制到协议端的鉴权 Token 并保存」；`wsHost` / `wsPort` / `wsPath` 统一改用「协议端」统称（NapCat / SnowLuma 都适用），并强调路径结尾 `/ws` 不能少；`wsUrl` 补上「仅正向模式使用」的说明。
- **图文教程**：第 2 步新增醒目提示「别忘了点保存连接」并解释其症状；检查清单补「并点了保存连接」；全文把操作对象改称「协议端」，避免与实际使用的 SnowLuma 混淆。
- 顺带修掉 `qq_qzone_post` 工具描述里残留的 `file://`（0.3.0 已移除该支持，描述漏改）。

## 0.3.5

修正 0.3.4 那张「设置反向客户端」配图：红框位置不准（偏左约 260px、没裁剪、边缘混入了桌面背景）。

- 改用**像素级颜色分层扫描**定位控件边界（遮罩灰 `151,149,147` / 弹窗米白 `255,248,240` / 输入框白 `254,253,251`），实测两个输入框均为 `x 576–1343`，URL 框 `y 395–440`、Token 框 `y 732–777`，弹窗本体 `x 540–1379, y 172–960`。
- 按实测坐标重新画框并裁到弹窗边界，编号 ① 服务端 WebSocket URL、② 鉴权 Token。
- 单文件离线版重新生成（3.11MB，较上一版更小——裁掉了多余背景）。

> 此前用「网格叠加 + 目测读数」标定坐标不可靠：标签密集时会重叠误读。这次改用像素扫描直接测边界。

## 0.3.4

修正图文教程里会导致「连不上」的错误。

- **反向客户端的服务端地址补上了结尾的 `/ws`**。此前写成 `.../onebot/v11`，而桌宠的路径默认是 `/onebot/v11/ws`，少这段会一直连不上，且多数实现不给出明显报错。
- 该步配图换成实测截图，红框标出**服务端 WebSocket URL** 与**鉴权 Token** 两个输入框。
- Token 说明改用界面的真实叫法「鉴权 Token」，并说明桌宠同时接受 `Authorization` 请求头与 URL Query 两种传参。
- 检查清单与「连不上怎么排查」FAQ 同步补上 `/ws` 这一条。
- 新增一张标注图 `docs/img/step-17.png`（共 20 张）。

## 0.3.3

修复 0.3.0 引入鉴权后 NapCat 完全连不上的问题（用户实测反馈）。

- **反向服务端现在按 OneBot v11 标准校验 `Authorization: Bearer <token>` 请求头**。此前只从 query 读 `?access_token=` / `?token=`，而 NapCat / Lagrange 等实现默认把 token 放在 `Authorization` 头里（框架内置的 qq world 也是这么发的，见 `src/worlds/qq/driver.ts`），于是每一次接入都被判「Token 不匹配」——NapCat 反复重连、桌宠一直显示未连接，且日志看不出真正原因。
- 仍然兼容 query 传参（`?access_token=` / `?token=`），因为反向监听地址是 NapCat 侧手填的，用法不统一。
- 拒绝日志改为只记录 `presented: boolean`，不再回显实际 token 值。

## 0.3.2

修复 0.3.1 引入的两个问题（都是用户实际反馈的）：

- **自动生成的 token 在重启进程后可能读不到**：`ensureReverseToken()` 原先只在 `createDriver()` 里调用，而面板与工具在 `start()` 之后、driver 建立之前也可能读取 token，那段时间拿到的是空串。现在 `start()` 开头无条件调用一次，`createDriver()` 里保留一次兜底。
- **图文教程把端口写死成 `8080`**：用户实际配置的端口可能不同（实例上就是 `8090`），照着教程填会一直连不上且原因难查。教程改为**以「连接与监听」面板显示的端口/路径为准**，并新增一条提示说明端口不一致是最常见原因、检查清单与 FAQ 同步修正。

同时说明：token 只持久化到 `dataDir/reverse-token.txt`，`config.json` 里的 `token` 字段仍保持用户自填值（默认为空）。因为 `World` 契约不提供配置写入 API，扩展无法自行落盘；每次启动从该文件读回同一串，因此跨重启稳定。

## 0.3.1

修正文档：0.3.0 引入了反向连接强制 Token，但图文教程仍写着「Token 留空」，会让人照着做却连不上。

- `docs/guide.md`：第 2 步「设置反向客户端」补充说明 Token 要填桌宠生成的那串，并加了两个 Token 的对照表（正向那个 vs 反向这个）；第 13 步改为「Token 要填到 NapCat」，说明 Token 在「连接与监听」页面顶部、两边必须一致；检查清单新增一条；FAQ 重写「Token 弄丢怎么办」并新增「反向连不上怎么排查」。
- `docs/index.html` 与单文件离线版同步上述修正。
- README 要点速记同步（反向连接必须带 Token、监听地址保持 `127.0.0.1`）。

## 0.3.0

安全修复（认证评审 `Pal-AI-Lab/cortico-extensions#104` 要求）。**含行为变更，升级前请读**：

- **反向监听默认改为 `127.0.0.1`**，不再是 `0.0.0.0`。原来默认监听所有网卡，同网段任何机器都能连入、读取 bot 下行消息并伪造入站事件（含 `get_group_member_info` 等管理接口）。若你确实需要对外监听，须显式改 `wsHost` **并设置 OneBot Token**，否则会拒绝启动。
- **反向连接必须带鉴权**：token 留空时自动生成随机 token 并持久化到 `dataDir/reverse-token.txt`（跨重启稳定），控制台「连接与监听」页与启动日志会显示，请填进 NapCat「设置反向客户端」。driver 侧新增安全闸：对外监听且无 token 时直接拒绝启动。
- **修复表情包路径穿越**：`[表情包:文件名]` 过去直接 `join(emojiDir, fname)`，群友发 `..\..\` 即可让 bot 读取并外传本机任意文件。现做三重收敛——拒绝绝对路径与 `..`、解析后必须仍在表情包目录内、符号链接按真实路径复验、必须是普通文件；越界一律静默丢弃。
- **QQ 空间附图不再接受 `file://`**：该协议会让 NapCat 直接读取本机文件上传，等于把「读取并外传本机文件」交给任何能影响模型输出的人（如群消息提示词注入）。现只接受 `http(s)://` 与 `base64://`。
- 新增 `tests/security.test.ts`（7 项）固化上述修复，防止回退。

文档修正（与代码对齐）：

- `api: 5` → `api: 6`（此前写错）。
- 移除「语音电话（call）」整章与 `voice.voiceTranscribeUrl` / `voice.voiceExtraAsr` / `voice.voiceFfmpegPath` / `voice.voiceTranscribeTimeout` 等**代码里并不存在的配置项**（`call.*` 与 `audio_bridge_poc` 从未包含在发布包内）。语音相关配置改为如实描述现有的 `asr.*` 段。
- 补齐文档中漏写的 9 个工具：`qq_admin_kick`、`qq_alias_set/forget/list`、`qq_poke`、`qq_proactive_status/trigger`、`qq_sticker_stats`、`qq_view_image`。现README 覆盖全部 37 个工具。
- 新增「与 cortico-world-memory 的关系」一节，说明笔记本是**可选增强而非依赖**（未装该插件时回退原生 JSONL，功能完整），并说明框架 `World` 契约没有 World 间发布/订阅通道，故采用最小能力协商而非事件流。

## 0.2.12

- 声明市场标签 `im` / `qq` / `external-setup`，便于在市场里按平台筛选（`external-setup` 表示需先装好 NapCat）。
- `CHANGELOG.md` 加入 `files`，随包分发，市场可直接显示各版本更新说明。

## 0.2.11

- 新增 `CHANGELOG.md`，记录各版本改动，供市场「更新说明」读取。

## 0.2.10

- 接入教程改为 Markdown（`docs/guide.md`），GitHub 上直接渲染成图文教程；文件名改用 ASCII，避免中文名在 URL 里需编码。
- 面板顶部新增「使用教程」入口与「重启连接」按钮（`restartConnection`），改完连接参数不用重启整个桌宠。

- 接入教程改为 Markdown（`docs/guide.md`），GitHub 上直接渲染成图文教程；文件名改用 ASCII，避免中文名在 URL 里需编码。
- 面板顶部新增「使用教程」入口与「重启连接」按钮（`restartConnection`），改完连接参数不用重启整个桌宠。

## 0.2.9

- 新增图文接入教程（安装 NapCatQQ、建 Bot、建正向/反向连接、装扩展、配监听名单、提示词生效）。

## 0.2.8

- 教程抽图瘦身，HTML 从 3.3MB 降到 39KB，图片改为独立文件。
- README 新增「接入教程」章节与要点速记。

## 0.2.7

- 面板顺序调整：连接与监听 → 监听名单 → 其余模块 → 实时事件。
- 「连接与监听」页新增「使用教程」链接与「重启连接」按钮。

## 0.2.6

- 监听名单面板改为与配置栏一致：输入框失焦或按 Enter 即自动保存，保存后不再重建表单（原先会把用户输入的 `111,222` 改写成 `111 222`，看起来像没保存）。

## 0.2.5

- 修复表情映射两套编号体系打架：`QQ_FACE_NAMES` 按 NapCat QSid 重建，`QQ_FACE_IDS` 改为由正向表反向生成。此前收到表情会显示错名字（如真实 QSid 210「飙泪」被显示成「玫瑰」）、`[笑哭]` 会解析成「偷笑」。
- 新增往返恒等测试与 NapCat QSid 抽查。

## 0.2.4

- 修复监听名单清空后无法保存：空串被解析成 `[0]`（`Number("")===0` 且 `isFinite(0)`），表现为清空后读回来永远显示「0」。`toIds` 改为只收正整数。
- 配置栏输入框支持 Enter 提交（原先只有失焦才保存）。
- 修复扩展根目录推断的层级错位，以及中文路径下 `import.meta.url` 的解码错误。

## 0.2.3

- 发布到 npm，可从扩展市场安装。