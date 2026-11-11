#!/usr/bin/env python3
"""Set up and manage one user-owned Codex Feishu Bridge instance."""

import argparse
from getpass import getpass
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time

SOURCE = Path(__file__).resolve().parent / "src"
ROOT = Path.home() / "Library/Application Support/CodexFeishuBridge"
LABEL = "local.codex-feishu"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
LAUNCHCTL = "/bin/launchctl"
PYTHON = "/usr/bin/python3"
DOMAIN = f"gui/{os.getuid()}"


def absolute_executable(value):
    path = Path(value).expanduser().absolute()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"不可执行：{path}")
    return str(path)


def private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"目录须由当前用户持有且权限为 700：{path}")


def run(arguments, **options):
    return subprocess.run(arguments, check=True, timeout=15, **options)


def write_once(path, body):
    with path.open("xb") as output:
        output.write(body)


def init(args, root):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", args.thread):
        raise ValueError("请提供 Codex 桌面聊天 ID")
    if not 1 <= args.settings_port <= 65535:
        raise ValueError("端口须在 1–65535 之间")
    workspace = args.workspace.expanduser().resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError("聊天工作目录不存在")
    if args.title.strip() != args.title or not 1 <= len(args.title) <= 160:
        raise ValueError("聊天名称须为 1–160 个字符")
    if (args.all_local_reports or args.recent_replies or args.questions) and not args.metadata_db:
        raise ValueError("全主聊天汇报、最近回复和问题回复需要 --metadata-db")
    if args.owner_open_id and not re.fullmatch(r"ou_[A-Za-z0-9_-]+", args.owner_open_id):
        raise ValueError("本人 Open ID 格式无效")
    codex = absolute_executable(args.codex_bin)
    if not args.node:
        raise ValueError("找不到 Node.js，请安装后提供 --node 的绝对路径")
    node_command = absolute_executable(args.node)
    # Invoke the named shim first, then persist the actual Node binary for launchd's minimal PATH.
    node_path = run([node_command, "-e",
                     "if (+process.versions.node.split('.')[0] < 24) process.exit(1); console.log(process.execPath)"],
                    capture_output=True, text=True).stdout.strip()
    node = absolute_executable(node_path)
    queue_help = run([codex, "queue", "--help"], capture_output=True, text=True).stdout
    if not all(flag in queue_help for flag in ("--thread", "--message")):
        raise ValueError("此 Codex CLI 未提供所需的 queue 接口")
    if not (SOURCE.parent / "node_modules/@larksuiteoapi/node-sdk/package.json").is_file():
        raise ValueError("请先在仓库目录运行 npm ci")
    config = {"version": 1, "sourceDirectory": str(SOURCE), "nodeBinary": node,
              "codexBinary": codex, "controlThreadId": args.thread, "settingsPort": args.settings_port,
              "chatManagementEnabled": args.chat_management, "mediaEnabled": args.media,
              "allLocalReportsEnabled": args.all_local_reports, "recentRepliesEnabled": args.recent_replies, "questionsEnabled": args.questions}
    if args.metadata_db:
        database = args.metadata_db.expanduser().resolve(strict=True)
        if not database.is_file():
            raise ValueError("聊天元数据文件无效")
        config["chatMetadataDatabase"] = str(database)
    paths = [root / name for name in ("service.json", "session-catalog.json", "app.credentials.json", "report-policy.json")]
    if any(os.path.lexists(path) for path in paths):
        raise ValueError("已有配置。请编辑现有私密文件，或为新实例指定独立目录")
    app_id = input("飞书 App ID：").strip()
    secret = getpass("飞书 App Secret（输入隐藏）：").strip()
    if not re.fullmatch(r"cli_[0-9a-fA-F]{16}", app_id) or len(secret) < 8:
        raise ValueError("应用凭据格式无效")
    credentials = {"app_id": app_id, "app_secret": secret}
    if args.owner_open_id:
        credentials["owner_open_id"] = args.owner_open_id
    private_directory(root)
    files = [(paths[0], config),
             (paths[1], {"version": 1, "defaultSessionId": args.thread,
                         "sessions": [{"sessionId": args.thread, "title": args.title, "cwd": str(workspace)}]}),
             (paths[2], credentials)]
    if args.all_local_reports:
        files.append((paths[3], {"version": 1, "scope": "all_local_main_chats", "enabled": True,
                                 "activatedAtMs": time.time_ns() // 1_000_000}))
    written = []
    try:
        for path, value in files:
            with path.open("x", encoding="utf-8") as output:
                written.append(path)
                json.dump(value, output, indent=2, ensure_ascii=False)
                output.write("\n")
    except OSError:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    print(f"已初始化 {root}。先运行 foreground，或使用 install 启用登录服务。")


def program_arguments(root):
    return [PYTHON, str(SOURCE / "service-launcher.py"), "--root", str(root)]


def installed_job(root):
    info = PLIST.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("登录项文件的归属或权限不符合要求")
    job = plistlib.loads(PLIST.read_bytes())
    if job.get("Label") != LABEL or job.get("ProgramArguments") != program_arguments(root):
        raise ValueError("登录项属于另一份安装，操作已停止")


def service(command, root):
    if sys.platform != "darwin":
        raise ValueError("登录服务需要 macOS")
    target = f"{DOMAIN}/{LABEL}"
    if command == "install":
        private_directory(root)
        if not (root / "service.json").is_file():
            raise ValueError("请先运行 init")
        if os.path.lexists(PLIST):
            raise ValueError(f"已有 {PLIST}，请先核对现有安装")
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        job = {"Label": LABEL, "ProgramArguments": program_arguments(root), "RunAtLoad": True, "KeepAlive": True,
               "LimitLoadToSessionType": "Aqua", "ProcessType": "Background", "ExitTimeOut": 20,
               "ThrottleInterval": 10, "Umask": 0o077, "WorkingDirectory": str(SOURCE)}
        write_once(PLIST, plistlib.dumps(job))
        try:
            run([LAUNCHCTL, "bootstrap", DOMAIN, str(PLIST)])
        except (subprocess.SubprocessError, OSError):
            # Preserve the descriptor if launchd loaded it despite the failed return.
            if subprocess.run([LAUNCHCTL, "print", target], capture_output=True, timeout=5).returncode != 0:
                PLIST.unlink(missing_ok=True)
            raise
        return
    installed_job(root)
    loaded = subprocess.run([LAUNCHCTL, "print", target], capture_output=True, timeout=5).returncode == 0
    if command == "start" and not loaded:
        run([LAUNCHCTL, "bootstrap", DOMAIN, str(PLIST)])
    if command in ("stop", "uninstall") and loaded:
        run([LAUNCHCTL, "bootout", target])
    if command == "uninstall":
        PLIST.unlink()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="私密运行目录，须在源码仓库之外")
    sub = parser.add_subparsers(dest="command", required=True)
    setup = sub.add_parser("init", help="创建私密配置，交互输入飞书凭据")
    setup.add_argument("--thread", required=True)
    setup.add_argument("--workspace", required=True, type=Path)
    setup.add_argument("--codex-bin", required=True)
    setup.add_argument("--node", default=shutil.which("node"))
    setup.add_argument("--title", default="Codex")
    setup.add_argument("--settings-port", type=int, default=59431)
    setup.add_argument("--owner-open-id")
    setup.add_argument("--media", action="store_true")
    setup.add_argument("--chat-management", action="store_true")
    setup.add_argument("--metadata-db", type=Path)
    setup.add_argument("--all-local-reports", action="store_true")
    setup.add_argument("--recent-replies", action="store_true")
    setup.add_argument("--questions", action="store_true", help="转发启用后的本机主聊天异步提问，并将回答加入原聊天")
    for name in ("foreground", "install", "start", "stop", "uninstall", "status", "hook-config"):
        sub.add_parser(name)
    args = parser.parse_args()
    root = args.root.expanduser().absolute()
    try:
        if root.is_symlink() or SOURCE.parent in (root.resolve(), *root.resolve().parents):
            raise ValueError("私密运行目录必须位于源码仓库之外，且不能是符号链接")
        if args.command == "init":
            init(args, root)
        elif args.command == "hook-config":
            command = shlex.join([PYTHON, str(SOURCE / "report-hook.py"), "--root", str(root)])
            print(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": command, "timeout": 5}]}]}}, indent=2))
        elif args.command == "foreground":
            os.execv(PYTHON, program_arguments(root))
        elif args.command == "status":
            return subprocess.call([PYTHON, str(SOURCE / "service-status.py"), "--root", str(root), "--require-online"])
        else:
            service(args.command, root)
        return 0
    except (ValueError, OSError, EOFError, subprocess.SubprocessError) as error:
        print(f"操作失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
