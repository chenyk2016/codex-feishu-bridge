# Codex Feishu Bridge · Codex 飞书连接

**在飞书私聊里继续 Mac 上的 Codex 桌面聊天，接收回复，并回答中途问题。**

[English](README.en.md) · [安装与配对](docs/setup.md) · [使用与排障](docs/usage.md) · [常见问题](docs/faq.md) · [兼容与验证范围](docs/compatibility.md)

![Codex 飞书连接：手机飞书通过 Mac 上的桥接与原 Codex 聊天往返，Codex 负责执行和权限判断](docs/public/images/overview.svg)

当前为 0.x 早期版本。这是一个在本机运行的、面向**单个配对用户**的社区开源桥接。飞书通过长连接传递消息，Codex 在你的 Mac 上继续工作。无需对公网开放本机服务，也无需把项目搬到另一个 Agent。项目采用 [MIT 许可证](LICENSE)，与 OpenAI、飞书及字节跳动均无官方隶属关系。

## 适合什么场景

- 电脑上的 Codex 正在处理任务，你离开桌面后想用手机补充要求、查看本轮结果。
- 同时维护几个聊天，希望在飞书里切换目标，或引用回复卡继续对应的聊天。
- Codex 中途需要你选择方案，希望在飞书收到问题并把答案送回原聊天。

桥接需要 Mac 保持登录、联网且可运行 Codex。它不是云端托管 Agent、多用户机器人或远程桌面。

## 功能与开启方式

| 能力 | 可用方式 | 关键边界 |
| --- | --- | --- |
| 私聊续聊、切换聊天 | 基础功能 | 消息进入选定的本机聊天；入队成功不等于开始执行 |
| 本轮最终回复卡 | 安装并信任 Stop Hook | 默认仅汇报明确登记的聊天，不是逐字流式转发 |
| 本机暂停与恢复 | 基础功能 | 关闭连接后跳过积压，已经投递的任务仍可能继续 |
| 中途异步问题与答案 | 可选 `--questions`，需要元数据索引 | 答案回到提出问题的聊天；**桌面问题框不会自动关闭** |
| 图片收发、Mermaid 图表 | 可选 `--media` | 发送目录需授权；Mermaid 渲染另需本机 Chrome |
| 全主聊天汇报、最近回复 | 分别显式开启 | 扩大到本机主聊天的范围，启用前确认愿意向飞书发送这些内容 |
| 新建桌面聊天 | 实验性 `--chat-management` | 控制聊天须能使用桌面管理工具，目录须是已登记项目 |

普通工具审批仍由 Codex 原有流程处理。同步阻塞提问、桌面问题状态同步、Windows/Linux 和国际版 Lark 不在当前支持承诺内。完整边界见[常见问题](docs/faq.md)与[兼容说明](docs/compatibility.md)。

## 快速开始

准备：macOS、Node.js 24+、macOS 系统 Python 3、支持 `queue --thread --message` 的 Codex 桌面 CLI，以及可创建飞书企业自建应用的账号。**需要先配置飞书消息事件和卡片回调**，完整步骤见[安装与配对](docs/setup.md)。

获取仓库并在根目录运行以下命令，将尖括号示例替换为真实值：

```sh
npm ci
/usr/bin/python3 manage.py init \
  --thread '<你的 Codex 聊天 ID>' \
  --workspace '/你的聊天工作目录' \
  --codex-bin '/Codex 桌面 CLI 的绝对路径' \
  --title '我的 Codex 聊天'
/usr/bin/python3 manage.py foreground
```

初始化会交互询问 App ID 和 App Secret，不要把凭据写入命令或提交到仓库。按[配对步骤](docs/setup.md)完成本人私聊绑定，先发「当前聊天」，再发一条测试任务并在桌面确认实际执行。

要接收 Codex 回复，运行 `/usr/bin/python3 manage.py hook-config`，按安装说明将输出的 Stop 条目追加到现有 Hook 配置并在 Codex 中审阅信任。前台测试完成后退出前台进程，再安装登录服务：

```sh
/usr/bin/python3 manage.py install
/usr/bin/python3 manage.py status
```

默认设置页为 [http://127.0.0.1:59431](http://127.0.0.1:59431/)，仅在本机服务运行时可用。默认私密数据目录为 `~/Library/Application Support/CodexFeishuBridge`，与源码分开。升级、暂停、恢复与卸载见[使用指南](docs/usage.md)。

## 一条消息怎样往返

1. 你在飞书给机器人发任务，桥接核对配对身份并确定目标聊天。
2. 桥接通过 Codex 的消息队列投递；「已加入原聊天」表示入队，不表示完成。
3. Codex 在原聊天执行，继续使用自己的工具权限机制。
4. 一轮结束后，Stop Hook 保存最终回复，桥接将其发成飞书卡片。

异步问题走独立通道：发现新问题 → 发问题卡 → 收齐答案 → 将答案送回提出问题的聊天。它不会修改全局当前聊天，也不会提交桌面原生问题框。更多见[架构与代码入口](docs/architecture.md)。

## 数据与安全

- 应用凭据、配对码、聊天正文、待发队列和媒体缓存保存在本机私密运行目录，不属于公开源码。
- 开启的汇报、问题和媒体会发送到飞书；“本机运行”不等于内容不离开设备。
- 本机设置页仅监听回环地址。不要把它映射到公网。
- 结果未知时不自动重投，避免同一任务重复执行。回复及媒体缓存目前需要手动清理。

完整说明与私下漏洞反馈方式见 [SECURITY.md](SECURITY.md)。

## 文档导航

| 你要做什么 | 文档 |
| --- | --- |
| 第一次安装、创建机器人、配对和登录自启 | [安装与配对](docs/setup.md) |
| 切换聊天、开关功能、排障和卸载 | [使用与排障](docs/usage.md) |
| 了解为什么问题框没关闭、能否支持 Lark 等 | [常见问题](docs/faq.md) |
| 判断当前版本是否适合自己的环境 | [兼容与验证范围](docs/compatibility.md) |
| 找模块、了解消息流和故障处理 | [架构](docs/architecture.md) |
| 准备发布和维护版本 | [发布维护](docs/releasing.md) |
| 填写 GitHub 简介、SEO 与 AI 阅读资料 | [搜索与项目资料](docs/discovery.md) |

## 开发与贡献

```sh
npm ci
npm run check
npm test
npm run docs:build
npm run docs:check
```

默认测试使用隔离数据与模拟输入。有 Google Chrome 的 Mac 可额外运行 `npm run test:mermaid` 验证实际图表渲染。测试通过不代替新机器上的真实飞书往返；报告问题时请按[贡献指南](CONTRIBUTING.md)提供脱敏复现。

欢迎兼容性报告、安装说明改进、回归测试和修复。后续重点是独立新装的端到端验证、客户端版本适配、冷启动恢复和原生答题状态同步的可行性；这些是待验证方向，不是已实现功能或交付日期承诺。

[更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全政策](SECURITY.md) · [MIT 许可证](LICENSE)
