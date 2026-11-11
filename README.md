# Codex 飞书连接

[English](README.en.md) · [安装与配对](docs/setup.md) · [使用与排障](docs/usage.md) · [架构](docs/architecture.md)

在飞书私聊里继续 Mac 上的 Codex 桌面聊天，收取本轮回复。桥接在你的 Mac 上运行，通过飞书自建应用的长连接收消息，本机浏览器可以随时暂停或恢复收发。

## 能做什么

| 能力 | 使用方式 |
| --- | --- |
| 续聊 | 在机器人私聊发任务，桥接将消息加入选定的 Codex 聊天 |
| 回复汇报 | 配置 Codex 的 Stop Hook 后，已登记聊天的本轮最终回复会发回飞书 |
| 切换聊天 | 发「菜单」「切换聊天」或「当前聊天」，支持从已发出的卡片回复原聊天 |
| 暂停飞书 | 在 Mac 浏览器打开本机设置页，关闭「连接飞书」。恢复后跳过积压 |
| 图片和 Mermaid | 可选。收取私聊图片，发送已授权目录里的图片，或在本机将 Mermaid 渲染成 PNG |
| 全主聊天汇报与最近回复 | 可选。显式开启后使用本机聊天元数据 |
| 新建桌面聊天 | 实验性。需要控制聊天中的桌面管理工具和项目已登记 |

项目面向单个配对用户。Codex 自己处理工具权限，普通审批仍走原有流程。入队只说明 Codex 收到排队请求，执行和完成需要看原聊天或之后的汇报。

## 快速开始

需要 macOS、Node.js 24+、macOS 的 Python 3、支持 `queue --thread --message` 的 Codex 桌面 CLI，以及可创建飞书企业自建应用的账号。图表渲染另需本机 Google Chrome。

1. 获取本仓库，在根目录运行 `npm ci`。
2. 按[安装与配对](docs/setup.md)创建飞书机器人，准备 Codex 聊天 ID 和桌面 CLI 路径。
3. 用 `/usr/bin/python3 manage.py init` 初始化本机配置。先前台运行并配对，再安装为登录服务。
4. 如需飞书收取 Codex 回复，按文档添加并审阅 Stop Hook。

默认设置页为 [127.0.0.1:59431](http://127.0.0.1:59431/)。它仅在服务运行时可访问，端口可以在初始化时设置。Mac 休眠、断网或尚未登录时，无法保持连接。

## 开发

```sh
npm ci
npm run check
npm test
```

默认测试使用隔离数据和模拟输入。安装了 Google Chrome 的 Mac 可额外运行 `npm run test:mermaid`。目录和关键入口见[架构](docs/architecture.md)，版本记录见[更新日志](CHANGELOG.md)。

这是独立社区项目。Codex 和飞书的账号、平台权限和客户端兼容性分别由各自平台决定。

[贡献指南](CONTRIBUTING.md) · [安全与数据说明](SECURITY.md) · [MIT 许可证](LICENSE)
