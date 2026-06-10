# Pi Mono Extensions

A collection of Pi extensions and skills for [Pi](https://github.com/earendil-works/pi), the open-source AI coding agent.

## Extensions

| Extension | Description | Install |
|-----------|-------------|---------|
| **compact-buddy** | Route context compaction to free OpenCode models instead of your main model | `./compact-buddy` |
| **glm-buddy** | Rate-limits GLM model usage during z.ai peak hours and tracks quota | `./glm-buddy` |
| **gpt-buddy** | Monitor ChatGPT/Codex usage quota with a status bar and `/gpt` command | `./gpt-buddy` |
| **opencode-pi** | OpenCode Zen free models provider for Pi agent | `./opencode-pi` |
| **pi-filesystem** | Native filesystem tools for read, write, edit, delete, move, copy, search, and tree | `./pi-filesystem` |
| **pi-mcp** | MCP client for Pi agent | `./pi-mcp` |
| **pi-safedelete** | Confirmation gate for delete/write commands in bash tool calls | `./pi-safedelete` |
| **pi-superpowers** | Superpowers development methodology: brainstorming, TDD, debugging, planning, and reviews | `./pi-superpowers` |

## Install

Install the full collection with current Pi package support:

```bash
pi install git:github.com/Denveous/pi-mono-exts
```

Use a local checkout while developing:

```bash
pi install G:/Development/Working/pi-dev/pi-extensions
```

If your Pi version does not load multiple resources from a package manifest yet, install a single extension folder instead:

```bash
pi install ./compact-buddy
```

## Repository Structure

Each extension folder contains its own `package.json` with a `pi.extensions` entry, so the folder can be installed independently. The root `package.json` declares every extension and the `pi-superpowers` skills for Pi versions that support multi-resource package manifests.

## License

MIT
