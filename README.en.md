# Codex Feishu Bridge

**Continue a Codex desktop chat on your Mac from Feishu, receive replies, and answer questions along the way.**

[简体中文](README.md) · [Setup](docs/setup.md) · [Usage](docs/usage.md) · [FAQ](docs/faq.md) · [Compatibility](docs/compatibility.md)

![A private Feishu conversation connects through a bridge on your Mac to the original Codex desktop chat](docs/public/images/overview.svg)

An early 0.x project. A self-hosted bridge for **one paired Feishu user**. A local process receives bot messages over a persistent connection and routes them to your existing Codex desktop chats. No public inbound server is required. This is an independent community project, licensed under [MIT](LICENSE), with no official affiliation with OpenAI, Feishu, or ByteDance. Detailed guides are currently in Chinese.

## What it is for

Check the result of a task after leaving your desk, send additional instructions from your phone, switch between registered chats, or answer a question without returning to your Mac. Your Mac must remain signed in, online, and able to run Codex. This is not a hosted agent service, a multi-user bot, or a remote desktop.

## Features

| Capability | Enablement | Boundary |
| --- | --- | --- |
| Private chat messages and chat switching | Core | Queued messages are not execution receipts |
| Final reply cards | Configure and trust the Stop hook | Registered chats by default; no token-by-token streaming |
| Local pause and resume | Core | Skips backlog; work already queued may continue |
| Async question cards and answers | Opt in with `--questions` and a metadata database | Replies return to the source chat; **the native desktop question remains open** |
| Images and Mermaid diagrams | Opt in with `--media` | Allowed output directories; Chrome required for Mermaid rendering |
| Reports from all local main chats and recent replies | Separate opt-ins | Review the expanded disclosure scope before enabling |
| New desktop chats | Experimental `--chat-management` | Requires desktop management tools in the control chat and a registered project |

Normal tool approvals remain with Codex. Blocking input prompts, native question-state synchronization, Windows/Linux, and international Lark are outside current support commitments. See [compatibility and validation scope](docs/compatibility.md).

## Quick start

Requirements: macOS, Node.js 24+, macOS system Python 3, a Codex desktop CLI supporting `queue --thread --message`, and permission to create a Feishu internal app with its bot enabled. Configure both the message event and card callback subscriptions using the [setup guide](docs/setup.md).

From the repository root, replace the sample values below:

```sh
git clone https://github.com/chenyk2016/codex-feishu-bridge.git
cd codex-feishu-bridge
npm ci
/usr/bin/python3 manage.py init \
  --thread '<your Codex chat ID>' \
  --workspace '/absolute/path/to/chat/workspace' \
  --codex-bin '/absolute/path/to/desktop/codex' \
  --title 'My Codex chat'
/usr/bin/python3 manage.py foreground
```

Initialization asks for the App ID and App Secret interactively. Never commit credentials. Follow the pairing guide, send `当前聊天` to verify the target, then send a harmless task and confirm that it runs in the original desktop chat.

To receive replies, run `/usr/bin/python3 manage.py hook-config`, append the generated Stop entry to your existing hook configuration, and review and trust it in Codex. After the foreground check, stop that process and install the login service:

```sh
/usr/bin/python3 manage.py install
/usr/bin/python3 manage.py status
```

The default local settings page is [127.0.0.1:59431](http://127.0.0.1:59431/), available while the service runs. Private runtime data defaults to `~/Library/Application Support/CodexFeishuBridge`, outside the source checkout. See [usage and removal](docs/usage.md).

## How it works

1. You send a task in a private Feishu bot conversation.
2. The bridge checks the paired identity and target chat, then queues the message through the Codex CLI.
3. Codex executes in the original desktop chat under its existing permission model.
4. At the end of a turn, the Stop hook saves the final reply for the bridge to deliver as a card.

Async questions use a separate path: detect a new question, send a card, collect all answers, and queue them back to the source chat. This does not change the globally selected chat or submit the native desktop question form. See [architecture and code entry points](docs/architecture.md).

## Data and security

Credentials, pairing state, queued content, logs, and media caches stay in a private runtime directory and must not be published. Enabled replies, questions, and media are transmitted to Feishu; self-hosting does not mean that content never leaves the device. The settings page listens on loopback only. Do not expose it publicly.

Unknown delivery outcomes are not automatically replayed. Reply and media caches currently need manual cleanup. See the [security policy](SECURITY.md) for boundaries and vulnerability reporting.

## Development and project status

```sh
npm ci
npm run check
npm test
npm run docs:build
npm run docs:check
```

Default tests use isolated state and simulated inputs. On a Mac with Google Chrome, run `npm run test:mermaid` for real rendering checks. Tests do not replace a fresh-install Feishu round trip. Existing-install validation and unverified cases are listed separately in [compatibility](docs/compatibility.md).

Useful contributions include compatibility reports, setup improvements, regression tests, and fixes. Next areas to validate include fresh-install end-to-end behavior, client-version compatibility, cold-start recovery, and native question-state integration. These are directions, not shipped capabilities or delivery promises.

[FAQ](docs/faq.md) · [Changelog](CHANGELOG.md) · [Release guide](docs/releasing.md) · [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
