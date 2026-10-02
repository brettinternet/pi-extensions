# lsp

Read-only LSP diagnostics and code navigation for Pi. Servers start only when an LSP tool is called; there are no read/write hooks, automatic installs, or project-local Pi command/config discovery.

The tools supply agent guidance to prefer semantic navigation and check affected files after meaningful batches of edits. This is model-directed, not a mandatory post-edit hook: it avoids checking every edit, scanning the whole repository, or repeatedly retrying missing servers. Compiler checks and tests remain necessary.

## Tools

- `lsp_diagnostics` reports **clean**, **findings**, or **unknown**. Unknown never means clean. Pull diagnostics are preferred; push diagnostics prove a result only when the report version matches the synchronized document version. Unversioned pushes are advisory only.
- `lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_document_symbols`, and `lsp_workspace_symbols` provide read-only semantic queries.

File paths must resolve inside the active Pi `ctx.cwd`; symlinks escaping that workspace are rejected, including when previously opened paths are replaced. A nested package root is selected from markers such as `.git` (directory or worktree file), `Package.swift`, `go.mod`, `package.json`, `Cargo.toml`, and `pyproject.toml`. TypeScript/JavaScript prefer the nearest `tsconfig.json`/`jsconfig.json` within the workspace/repository boundary over a nested package manifest, so monorepos retain their compiler settings. Position inputs are 1-based line and UTF-16 code-unit column; LSP uses 0-based positions, converted by the extension. Result count, diagnostic/document state, and output text are bounded.

Some servers (including the tested TypeScript language server) publish unversioned diagnostics. Those appear only as advisory hints with **unknown** status and cannot establish clean, by design. SourceKit-LSP has passed semantic navigation in the optional smoke fixture; its initial push-only report can also be unknown until the server supplies a valid pull report.

## Servers

The extension uses installed servers already available on `PATH` only. It never downloads or installs them.

| Language | Server executable |
| --- | --- |
| Go | `gopls` |
| TypeScript / JavaScript | `typescript-language-server --stdio` |
| Python | `pyright-langserver --stdio` |
| Swift | `sourcekit-lsp` |
| Rust | `rust-analyzer` |
| Lua | `lua-language-server` |
| YAML | `yaml-language-server --stdio` |
| JSON | `vscode-json-language-server --stdio` |

Server commands and their inherited PATH use validated, absolute locations outside the active workspace. Executable symlink targets are checked, but external launcher names are preserved so Mise and Rustup shims dispatch correctly. TypeScript also requires an external `lib/tsserver.js`: pi-lsp locates an installed `tsserver` on trusted PATH or validates an explicit global path. It never falls back to workspace `node_modules/typescript`. Automatic TypeScript typing acquisition is always disabled, even if global initialization options request it.

`/lsp doctor` checks global config, enabled server commands, and the external TypeScript compiler without starting processes or installing anything. It reports each server as found, disabled, or unavailable, with paths and actionable errors. “Found” verifies discovery, not server startup or health; Mise shims may still require an installed tool. Only servers for languages you use need to be available.

`/lsp status` shows owned processes and `/lsp stop` stops them. All command arguments complete with Tab. After changing global config, use `/lsp stop` so the next tool call starts with the new settings. On macOS/Linux, teardown terminates the owned process group, including workers left by a crashed launcher. Windows currently stops only the launcher; full descendant cleanup is not supported there.

This is not a sandbox. Servers run with your permissions and may read project settings or invoke compilers, builds, and plugins. Use trusted projects. The extension ignores project-local Pi executable configuration; it cannot enforce every language server's internal trust or dependency behavior.

Each diagnostic acquisition synchronizes a new, client-wide monotonic document version; it does not reuse a previous clean push or pull report. The server remains responsible for its view of unopened dependencies. A clean report is not a substitute for the project's tests or compiler checks.

## Global configuration

The extension directory is `lsp`; the package name (`pi-lsp`) and global config filename are unchanged so existing installations keep working.

Optional configuration is read only from `getAgentDir()/pi-lsp.json` (normally `~/.pi/agent/pi-lsp.json`). Malformed configuration fails with its file path; there is no silent fallback. The supported map can disable a built-in server, replace its command, or pass a small JSON `initializationOptions` object. No project `.pi/lsp-client.json`, `.pi/lsp.json`, or `.pi-lsp.json` is read or executed.

```json
{
  "servers": {
    "typescript": {
      "initializationOptions": {
        "tsserver": {
          "path": "/path/to/typescript/lib/tsserver.js"
        }
      }
    },
    "gopls": {
      "disabled": true
    }
  }
}
```

The TypeScript `tsserver.path` option is useful when `typescript-language-server` is on PATH but the desired TypeScript installation (for example a separate Mise install) is not discoverable from the workspace. Use an absolute path to an already-installed external `lib/tsserver.js` with a readable TypeScript package manifest. An invalid explicit path fails closed instead of falling back to a project compiler. Commands can also be overridden globally:

```json
{
  "servers": {
    "gopls": { "command": ["/opt/go/bin/gopls"] }
  }
}
```

Only JSON values are accepted in `initializationOptions` (at most 8 nesting levels and 8 KB). Configuration is for trusted global use because language servers run with the user's operating-system permissions.

## Development

```sh
bun run check
bun test test/lsp
```

An optional Go/TypeScript/Swift smoke test runs against binaries already on PATH when `PI_LSP_REAL_SERVER_SMOKE=1`; it never installs dependencies. Upstream attribution and the exact source commit are recorded in [NOTICE](NOTICE).
