# 安装与配对

## 1. 准备飞书机器人

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用机器人，并将自己的账号加入应用可用范围。记录 App ID 和 App Secret。基础文本流程申请 `im:message:send_as_bot` 和 `im:message.p2p_msg:readonly`。计划启用图片时，再按飞书控制台申请图片资源与所需消息读取权限（`im:resource`、`im:message:readonly`）。

先完成下方本机配置并运行 `foreground`。等客户端建立连接后，在飞书后台分别配置以下两项，然后发布应用版本。

- 在事件订阅中选择长连接，添加 `im.message.receive_v1`。
- 在回调订阅中选择长连接，添加新版 `card.action.trigger`。这条回调用于点击聊天选择等卡片按钮。

租户要求审批时，等待权限或应用版本生效。建议一个应用只运行一个桥接实例。飞书长连接无需对公网开放本机端口。[长连接事件文档](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-) · [卡片回调文档](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)

## 2. 准备 Codex 和本机配置

在目标 Codex 桌面聊天里，让 Codex 读取这个聊天的 `CODEX_THREAD_ID`，并核对当前工作目录。先选一个已打开的本机聊天。桌面 CLI 的路径因版本而异。若安装在标准位置，可在终端运行以下命令找出候选，并对候选运行 `queue --help`。

```sh
find /Applications/ChatGPT.app/Contents/Resources -type f -name codex -print
```

回到仓库目录，把示例值换成本机的真实值。初始化时交互输入应用凭据，App Secret 的输入会隐藏。若已知道自己在这个应用里的 Open ID，可以追加 `--owner-open-id` 限定配对身份。

```sh
npm ci
/usr/bin/python3 manage.py init \
  --thread '<你的聊天 ID>' \
  --workspace '/你的聊天工作目录' \
  --codex-bin '/Codex 桌面 CLI 的绝对路径' \
  --title '我的 Codex 聊天'
```

默认运行目录为 `~/Library/Application Support/CodexFeishuBridge`。可以在每条 `manage.py` 命令的子命令之前传入 `--root '/绝对私密路径'`。目录须在仓库之外。如果默认端口被占用，可在初始化时传 `--settings-port 其他端口`。已经初始化的安装可在退出后台后编辑私密目录的 `service.json`。

## 3. 前台运行并配对

```sh
/usr/bin/python3 manage.py foreground
```

另开一个终端，使用下面的命令在本机查看配对提示。复制 `pairing_required` 记录里的 `sendThisExactTextInBotPrivateChat` 值，原样发到机器人**私聊**，并检查 `manage.py status` 是否报告在线。配对码在启动时生成，请勿将这条日志分享出去。配对后发「当前聊天」，再发一条无敏感内容的任务，回到桌面观察该任务是否实际执行。

```sh
tail -f "$HOME/Library/Application Support/CodexFeishuBridge/logs/connector.log"
```

配对后身份绑定到当前应用、发件人和私聊。换机器人或换绑定人时，先停止服务，再按[数据与卸载说明](usage.md#运行数据与卸载)保存旧目录并创建新实例，避免把旧队列带入新配对。

## 4. 接收 Codex 回复（可选）

```sh
/usr/bin/python3 manage.py hook-config
```

把输出里的命令项加入 `~/.codex/hooks.json` 的 `hooks.Stop`。已经有 Stop 条目时，追加输出中的 Stop 条目，保留其他 Hook。随后在 Codex 中审阅并信任该命令。在已登记聊天里完成一条普通回复，检查飞书收到的卡片标题和正文。默认仅汇报明确登记的聊天。Hook 会在本机保存待发回复，由桥接发送。移除该 Hook 即可停用自动汇报。[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)

## 5. 安装登录服务

结束前台运行后，执行以下命令。原目录保留在稳定路径，移动源码前先卸载登录项并更新 Hook。

```sh
/usr/bin/python3 manage.py install
/usr/bin/python3 manage.py status
```

安装器使用 `local.codex-feishu` 作为登录服务标识。如果已存在同名服务，安装会停止并保留原服务。用 `stop`、`start` 操作本仓库安装的服务，日常暂停收发用[设置页](http://127.0.0.1:59431/)开关。

### 可选：中途提问与回答

新装时添加 `--questions --metadata-db /绝对路径/state.sqlite`。现有安装在私密 service.json 配置 questionsEnabled=true 和已核对的 chatMetadataDatabase，再重启原连接。该功能读取启用后的本机主聊天异步提问，并将本人飞书答案加入原聊天；无需额外 Hook 或扩大审批权限。查看[使用与边界](usage.md#在飞书回答-codex-的中途提问)。

## 6. 第一次使用的验收

依次确认私聊发送任务、原桌面聊天实际执行、Stop 回复回到飞书。可选功能分别验收，不把“已入队”当作任务完成。开启异步问题后，应能收到问题卡并将答案送回原聊天；当前桌面问题框仍保留，不会自动关闭。首次独立安装的验证状态见[兼容性与验证](compatibility.md)。
