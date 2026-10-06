# chrome-control-mcp

MCP server + Chrome extension. Claude (or any MCP client) controls your real Chrome through the DevTools Protocol, in the background.
Tool names follow chrome-devtools-mcp, so prompts written for it work here too.

- [Quick start](#quick-start)
- [Commands](#commands)
- [Setup in detail](#setup-in-detail)
- [Using it](#using-it)
- [Run once, use from many clients](#run-once-use-from-many-clients)
- [Install by hand](#install-by-hand)
- [Tools (32)](#tools-32)
- [Tab reuse](#tab-reuse)
- [Hide the yellow debugging banner](#hide-the-yellow-debugging-banner)
- [Safety](#safety)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Update and uninstall](#update-and-uninstall)

## Quick start

Needs Node 18 or newer and Chrome (Edge, Brave and Chromium also work).

    npm install -g chrome-control-mcp
    chrome-control-mcp setup

No global install? Use `npx -y chrome-control-mcp setup` instead.

`setup` opens `chrome://extensions` and copies the extension folder path to your clipboard. Then:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked** and paste the folder path.
3. Restart Claude Desktop or Claude Code.

The extension gets its token by itself and turns ON. You paste nothing. Loading the extension is the only manual step,
because Chrome does not allow silent extension installs.

Check it works: ask Claude "open github.com and take a snapshot".

## Commands

Run `chrome-control-mcp help` any time to see this list.

| Command | What it does |
|---|---|
| `setup` | One-time install: native host, extension copy, Claude config. Opens `chrome://extensions`. |
| `serve` | Runs one shared server for many clients at `http://127.0.0.1:8766/mcp`. |
| `url` | Prints the shared server URL with its token. |
| `token` | Prints the secret token. |
| `extension` | Prints the folder to load in `chrome://extensions`. |
| `chrome` | Starts Chrome with the debugger banner hidden (`--silent-debugger-extension-api`). |
| `uninstall` | Removes the native host registration, host files and the extension copy. |
| `version` (`-v`, `--version`) | Prints the version. |
| `help` (`-h`, `--help`) | Shows the command list. |
| *(no command)* | Runs as an MCP server over stdio. This is what Claude launches. In a plain terminal it shows the help instead. |

`setup` options:

| Option | Meaning |
|---|---|
| `--no-claude` | Do not touch Claude Desktop or Claude Code config. |
| `--no-claude-desktop` / `--no-claude-code` | Skip just one of them. |
| `--no-open` | Do not open `chrome://extensions` or copy the path to the clipboard. |
| `--no-flag` | Do not add `--silent-debugger-extension-api` to Chrome shortcuts. |
| `--force` | Replace an existing `chrome-control` entry in Claude Desktop config. |
| `--extension-id <id>` | Allow another extension id, for example a Chrome Web Store build. |

## Setup in detail

`setup` does five things and prints each step:

1. Creates the secret token in `~/.chrome-control-mcp/token` (never printed).
2. Installs a small native host in `~/.chrome-control-mcp/native-host` and registers it for Chrome, Edge, Brave and Chromium.
   The extension uses it to read its token and port, so you never paste a token.
3. Copies the extension to `~/.chrome-control-mcp/extension` (a stable folder that survives package updates).
4. Adds `chrome-control` to Claude Desktop (a backup `.bak-chrome-control` is saved next to the config) and to Claude Code,
   when they are installed.

5. Hides Chrome's "started debugging this browser" banner by adding `--silent-debugger-extension-api` to your Chrome, Edge and
   Brave shortcuts (desktop, Start menu and taskbar on Windows; user launchers on Linux; on macOS use `chrome-control-mcp chrome`).
   Fully quit Chrome and reopen it from a patched shortcut for this to take effect. Skip it with `--no-flag`.

It is safe to run again. Existing entries are left alone unless you pass `--force`.

## Using it

After setup, Claude launches the server itself when needed, so you run nothing by hand. Control is **off by default**:
click the extension icon and use the toggle (it turns on automatically the first time). Turning it OFF closes the connection
and detaches the debugger from all tabs.

Example prompts:

- "Open example.com in a background tab and tell me the page title."
- "Fill the login form on this tab and click Sign in."
- "Take a screenshot of the pricing page."
- "List failed network requests on the current tab."

If you update the package, run `chrome-control-mcp setup` again, then ask Claude to run `reload_bridge_extension`
(or click reload on `chrome://extensions`).

## Run once, use from many clients

By default each client starts its own server process (they share the one extension connection). To run a single server that
every client connects to:

    chrome-control-mcp serve            (or npx -y chrome-control-mcp serve)

Windows users can also double-click `start-server.cmd` if they cloned the repo.

The server listens on `http://127.0.0.1:8766/mcp` (change with `CHROME_BRIDGE_HTTP_PORT`). Print the full URL, which includes
the token:

    chrome-control-mcp url

Connect clients to that URL:

    claude mcp add --transport http chrome-control "<url from the command above>"

Other clients that support Streamable HTTP MCP can use the same URL. Treat the URL like a password. The HTTP server only
accepts loopback connections, checks the Host header and rejects browser Origin headers.

## Install by hand

Use this if you do not want `setup` to edit anything.

1. Add the MCP server.

   Claude Code:

       claude mcp add chrome-control -- npx -y chrome-control-mcp

   Claude Desktop config:

       { "mcpServers": { "chrome-control": { "command": "npx", "args": ["-y", "chrome-control-mcp"] } } }

   On Windows Claude Desktop use `"command": "cmd", "args": ["/c", "npx", "-y", "chrome-control-mcp"]`.

2. Get the extension folder and the token:

       chrome-control-mcp extension
       chrome-control-mcp token

3. In Chrome open `chrome://extensions`, turn on Developer mode, click Load unpacked, pick the extension folder.
4. Click the extension icon, paste the token, turn on Enable control. (Not needed when the native host from `setup` is installed.)

## Tools (32)

| Group | Tools |
|---|---|
| Input | click, click_at, drag, fill, fill_form, handle_dialog, hover, press_key, type_text, upload_file |
| Navigation | list_pages, new_page, select_page, close_page, navigate_page, wait_for |
| Emulation | emulate, resize_page |
| Performance | performance_start_trace, performance_stop_trace, performance_analyze_insight |
| Network | list_network_requests, get_network_request |
| Debugging | take_snapshot, take_screenshot, evaluate_script, list_console_messages, get_console_message |
| Memory | take_heapsnapshot |
| Extra | cdp (raw DevTools command), status, reload_bridge_extension |

Not included: lighthouse_audit, screencast, heap snapshot analysis tools, extension/PWA/WebMCP categories.
Performance analysis is a lightweight reading of the raw trace, not the full DevTools trace engine.

## Tab reuse

`new_page` checks open tabs first. Same URL: the tab is reused. Same site: that tab is reused and navigated.
A new background tab opens only when no tab for that site exists. Pass `forceNew=true` to skip this.
`close_page` only closes tabs opened by the MCP unless `force=true`.

## Hide the yellow debugging banner

Chrome shows "started debugging this browser" with a Cancel button while an extension is attached. An extension cannot hide it;
only a Chrome startup flag can. `setup` adds the flag for you (see above). To do it by hand, add this to the Chrome shortcut's
Target field, or run `chrome-control-mcp chrome`:

    chrome.exe --silent-debugger-extension-api

Fully quit Chrome first and turn off "Continue running background apps" in `chrome://settings/system` so it really quits.
Check `chrome://version`: the flag must appear in the Command Line row. Chrome opened from a shortcut without the flag, or by
clicking a link in another app, still shows the banner.

## Safety

- Off by default. Toggle OFF closes the connection and detaches the debugger from all tabs.
- The WebSocket listens on 127.0.0.1 only. It needs a secret token and a `chrome-extension://` origin.
- The shared HTTP server listens on loopback only, needs the token, checks the Host header and blocks browser Origin headers.
- "Allowed sites" in the popup limits which sites can be controlled. Empty means all http/https sites.
- `Target.*`, `Browser.*`, `Storage.*` and `Network.getAllCookies` are blocked through the bridge.
- The extension can act as you on any allowed site while it is ON. Turn it OFF when you do not need it.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CHROME_BRIDGE_PORT` | 8765 | WebSocket port between the extension and the server. |
| `CHROME_BRIDGE_TOKEN` | saved in `~/.chrome-control-mcp/token` | Override the token. |
| `CHROME_BRIDGE_HTTP_PORT` | 8766 | Port for `serve`. |

## Troubleshooting

| Problem | Fix |
|---|---|
| Claude says the MCP is not connected | Restart Claude. Run `chrome-control-mcp setup` again. For Claude Code run `claude mcp list`. |
| `CONNECTION_CLOSED` or the tools time out | Check the extension is loaded and its toggle is ON. Run the `status` tool. |
| Extension does not turn on by itself | Run `chrome-control-mcp setup`, then reload the extension. Or paste the output of `chrome-control-mcp token` in the popup. |
| Port 8765 or 8766 is in use | Set `CHROME_BRIDGE_PORT` or `CHROME_BRIDGE_HTTP_PORT` and run `setup` again. |
| `chrome-control-mcp` is not found after global install | Open a new terminal. Check that the npm global bin folder is on your PATH (`npm prefix -g`). |
| Yellow "debugging" banner is still there | Quit Chrome fully, reopen from a patched shortcut or run `chrome-control-mcp chrome`. See [Hide the yellow debugging banner](#hide-the-yellow-debugging-banner). |
| Setup did not edit Claude config | Use [Install by hand](#install-by-hand). |

## Update and uninstall

Update:

    npm install -g chrome-control-mcp@latest
    chrome-control-mcp setup

Uninstall:

    chrome-control-mcp uninstall
    npm uninstall -g chrome-control-mcp

Your token file is kept. Remove the extension in `chrome://extensions` yourself, and remove the `chrome-control` entry from
Claude Desktop or Claude Code (`claude mcp remove chrome-control`).

## License

MIT
