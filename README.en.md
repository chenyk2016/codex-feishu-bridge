# Codex Feishu Bridge

[简体中文](README.md)

Continue a Codex desktop chat on your Mac from a private Feishu bot conversation. A local background process connects to Feishu and forwards your messages to the selected Codex thread. An optional Codex Stop hook sends the final reply from each eligible turn back to Feishu.

- Pair one account and switch between registered chats.
- Pause or resume Feishu from a loopback-only settings page. Pending messages from before resuming are skipped.
- Opt in to image delivery, local Mermaid rendering, reports from other local main chats, or experimental desktop chat creation.

You need macOS, Node.js 24 or later, the macOS system Python, a Codex desktop CLI with `queue --thread --message`, and a Feishu internal app with its bot enabled. Google Chrome is required for local Mermaid rendering. An accepted queue request is not an execution receipt.

Run `npm ci`, then follow the [setup and pairing guide](docs/setup.md). The default settings page is [127.0.0.1:59431](http://127.0.0.1:59431/).

[Usage](docs/usage.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT license](LICENSE)
