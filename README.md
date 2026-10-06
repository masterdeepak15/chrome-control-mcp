# chrome-control-mcp

MCP server + Chrome extension. Claude controls your real Chrome through the DevTools Protocol, in the background.
Tool names follow chrome-devtools-mcp, so prompts written for it work here too.

## Quick start

    npx -y chrome-control-mcp setup

This installs a small native host, copies the extension to ~/.chrome-control-mcp/extension and adds the MCP to
Claude Desktop and Claude Code automatically, when they are installed. Then open chrome://extensions, turn on Developer mode, click Load unpacked and pick
the folder that setup printed. The extension gets its token by itself and turns ON. You paste nothing.

Options: --no-claude, --no-claude-desktop, --no-claude-code, --force, --extension-id <id> (add another extension id, for example
a Chrome Web Store build). Remove everything with `npx chrome-control-mcp uninstall`.

## Install by hand

1. Add the MCP server (Claude Code):

       claude mcp add chrome-control -- npx -y chrome-control-mcp

   Claude Desktop config:

       { "mcpServers": { "chrome-control": { "command": "npx", "args": ["-y", "chrome-control-mcp"] } } }

2. Get the extension folder and the token:

       npx chrome-control-mcp extension
       npx chrome-control-mcp token

3. In Chrome open chrome://extensions, turn on Developer mode, click Load unpacked, pick the extension folder.
4. Click the extension icon. Paste the token. Turn on Enable control.

After you update the files, ask Claude to run reload_bridge_extension, or click reload on chrome://extensions.

## Tools (32)

Input: click, click_at, drag, fill, fill_form, handle_dialog, hover, press_key, type_text, upload_file
Navigation: list_pages, new_page, select_page, close_page, navigate_page, wait_for
Emulation: emulate, resize_page
Performance: performance_start_trace, performance_stop_trace, performance_analyze_insight
Network: list_network_requests, get_network_request
Debugging: take_snapshot, take_screenshot, evaluate_script, list_console_messages, get_console_message
Memory: take_heapsnapshot
Extra: cdp (raw DevTools command), status, reload_bridge_extension

Not included: lighthouse_audit, screencast, heap snapshot analysis tools, extension/PWA/WebMCP categories.
Performance analysis is a lightweight reading of the raw trace, not the full DevTools trace engine.

## Tab reuse

new_page checks open tabs first. Same URL: the tab is reused. Same site: that tab is reused and navigated.
A new background tab opens only when no tab for that site exists. Pass forceNew=true to skip this.
close_page only closes tabs opened by the MCP unless force=true.

## Hide the yellow debugging banner

Chrome shows "started debugging this browser" while an extension is attached. To hide it, fully quit Chrome
and start it with the flag:

    chrome.exe --silent-debugger-extension-api

Add the flag to the Chrome shortcut's Target field. Turn off "Continue running background apps" in
chrome://settings/system so Chrome really quits.

## Safety

- Off by default. Toggle OFF closes the connection and detaches the debugger from all tabs.
- WebSocket listens on 127.0.0.1 only. It needs a secret token and a chrome-extension:// origin.
- Allowed sites in the popup limit which sites can be controlled. Empty means all http/https sites.
- Target.*, Browser.*, Storage.* and Network.getAllCookies are blocked through the bridge.

## Environment

CHROME_BRIDGE_PORT (default 8765), CHROME_BRIDGE_TOKEN (default: saved in ~/.chrome-control-mcp/token).

## Run once, use from many clients

    node dist/index.js serve        (or double-click start-server.cmd)

Starts one server at http://127.0.0.1:8766/mcp (CHROME_BRIDGE_HTTP_PORT to change). Print the URL with token: `node dist/index.js url`.
Every client connects to that same URL at once:

    claude mcp add --transport http chrome-control "<url from the command above>"

Stdio mode (`npx -y chrome-control-mcp`) still works and shares the extension between instances.
