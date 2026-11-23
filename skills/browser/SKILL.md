---
name: browser
description: Use before the first Claude in Chrome (mcp__claude-in-chrome__*) action in a session, to pick which browser on this computer to use, and to register, list or remove this computer's browsers. Also when a pickwise hook blocked a browser tool.
---

# pickwise: browsers on this computer only

Claude in Chrome shows every connected browser of your account ("Browser 1..N"), from all your computers. The names change between sessions. pickwise keeps a registry per computer and uses only the browsers in it:

`~/.claude/pickwise/browsers/<hostname>.json`

The pickwise session context lists this computer's hostname, its registered browsers and the probe script path.

## Pick a browser (each session)

1. Call `list_connected_browsers`.
2. Keep only connected browsers whose deviceId is registered for this computer.
3. Ask with AskUserQuestion. Give one option per browser: label from the registry (e.g. `Edge (MY-PC)`), deviceId in the description.
4. Call `select_browser` with the chosen deviceId.

- Never call `switch_browser`: it sends a pairing request to every browser, on every computer.
- Never go by "Browser N" names.
- None registered, or none of them connected: stop and tell the user. Offer to register.

The pickwise hook blocks browser tools until a registered browser is selected in the session. It also blocks `select_browser` on unregistered ids, except while a registration probe runs.

## Register this computer's browsers

A browser is on this computer if it can open a page served on `127.0.0.1` here. The probe records each such browser, with its type from the User-Agent (Edge, Chrome, Brave...).

1. Tell the user what will happen. Each unregistered browser gets one tab. A tab on another computer only shows a connection error, and you close it.
2. Start the probe in the background (path from the session context):
   `node "<probe script>" serve 300`
   The default port is 47831. Use the port from the session context when it differs, as a third argument.
3. Call `list_connected_browsers`. For each browser not yet registered:
   - `select_browser` its deviceId
   - navigate to `http://127.0.0.1:47831/?id=<deviceId>`
   - close that tab
4. Stop the probe: `curl -s http://127.0.0.1:47831/quit`
5. Show the result: `node "<probe script>" list`. Browsers with no hit run on another computer. They stay unregistered.
6. Do the normal pick (above) so a registered browser is selected again.

Remove a browser: `node "<probe script>" remove <deviceId>`.

Each computer keeps its own registry. On a new computer, install pickwise and register there.
