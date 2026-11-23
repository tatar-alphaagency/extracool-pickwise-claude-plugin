# pickwise

**Pick wisely.** A Claude Code plugin by **ExTraCooL** that makes Claude choose its resources with care:

1. **Subagent models.** The main chat picks the right model for each subagent: `haiku`, `sonnet` or `opus`. It no longer copies the main chat's model by default. Expensive models such as **Fable** are gated. Claude asks you in chat first, and **Use Opus instead** is the recommended answer.
2. **Claude in Chrome browsers.** Claude uses only the browsers on the computer you are working on, and asks you which one (Edge, Chrome...) for every task. Without pickwise, the extension shows every browser of your account as "Browser 1..N", across all your computers, and the names change.

```
/plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin
/plugin install pickwise@extracool
```

---

## Contents

- [Why](#why)
- [Requirements](#requirements)
- [Install: Claude Code in a terminal](#install-claude-code-in-a-terminal)
- [Install: VS Code](#install-vs-code)
- [Use: subagent models](#use-subagent-models)
- [Use: browsers](#use-browsers)
- [Settings](#settings)
- [Update and uninstall](#update-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [ภาษาไทย](#ภาษาไทย)

## Why

- **Slow, expensive subagents.** A subagent with no model set inherits the main chat's model. If you chat on Opus or Fable, a simple file search also runs on Opus or Fable. pickwise has Claude set the model on every Agent call and every Workflow `agent()`, using the cheapest model that does the job well.
- **Fable by accident.** Fable is never used without your OK. Claude explains why Opus is not enough, and you choose:

  | Option | What happens |
  |---|---|
  | **Use Opus instead (Recommended)** | The same task runs on Opus, right away |
  | **Use Fable** | One call runs on Fable |
  | **Cancel** | The task stops |

  A hook enforces this, so it holds even if Claude forgets the rule.
- **Wrong browser, wrong computer.** With several computers and browsers connected to Claude in Chrome, Claude could drive a browser on another machine. pickwise keeps a list of browsers per computer and blocks every other one.

## Requirements

| | |
|---|---|
| Claude Code | A current version with plugin support (CLI or the VS Code extension). |
| Node.js | 18 or newer, on `PATH`. The hooks run with `node`. Without it the hooks do nothing, and Claude Code itself keeps working. |
| Windows | Git for Windows. Claude Code runs hooks with Git Bash. |
| Browser part | The Claude in Chrome extension in Chrome, Edge or another Chromium browser. Optional: you can turn this part off. |

## Install: Claude Code in a terminal

In a Claude Code session:

```
/plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin
/plugin install pickwise@extracool
```

Or from your shell:

```bash
claude plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin
claude plugin install pickwise@extracool
```

Then **start a new Claude Code session**: hooks and rules load at session start. You will see `Loading pickwise rules...` while it starts.

Check it: `claude plugin list` shows `pickwise@extracool` as enabled.

## Install: VS Code

The Claude Code extension for VS Code and the `claude` CLI share the same settings folder (`~/.claude`). A plugin installed once works in both.

1. Open the VS Code terminal (`` Ctrl+` ``) and run:
   ```bash
   claude plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin
   claude plugin install pickwise@extracool
   ```
   If your extension version supports slash commands in the Claude panel, you can type the two `/plugin` commands there instead.
2. Run **Developer: Reload Window** from the command palette (`Ctrl+Shift+P`), or open a new Claude conversation.
3. Use Claude as usual. The questions pickwise asks ("Use Opus instead?", "Which browser?") appear as choice dialogs in the Claude panel.

If `claude` is not found in the terminal, install the Claude Code CLI first. The VS Code extension alone may not put it on your `PATH`.

## Use: subagent models

There is nothing to type. Claude now sets a model on each subagent:

| Model | Default use |
|---|---|
| `haiku` | search, locate code, list files, read and summarize, 1-2 file mechanical edits, web fetch |
| `sonnet` | implement from a clear plan, write tests, code review, audits, most multi-file work |
| `opus` | architecture, hard debugging, security review, writing plans, tasks where sonnet already failed |

When a task seems to need Fable, Claude asks first, as shown in [Why](#why). Each approval allows **one** Fable call, within 10 minutes.

To read the rules in chat, type `/pickwise:model`.

## Use: browsers

### First time on each computer: register its browsers

Make sure the Claude in Chrome extension is connected in each browser you want to use. Then ask Claude:

> register the browsers of this computer

(or type `/pickwise:browser` and ask to register). Claude then:

1. starts a small probe server on `127.0.0.1:47831`. It listens on this computer only.
2. opens a tab at that address in each connected browser. Only a browser on **this** computer can load it, and its User-Agent tells Edge from Chrome.
3. saves the hits to `~/.claude/pickwise/browsers/<hostname>.json`, closes the tabs and stops the probe.

A browser on another computer only shows a "can't connect" tab for a moment, and Claude closes it. That browser is not registered.

Do this on each computer. Each one keeps its own list.

### Every task

Each message you send starts a new task. Before the first browser action in a task, Claude asks:

> Which browser on this computer (MY-PC) should Claude in Chrome use?
> ○ Edge (MY-PC) ○ Chrome (MY-PC)

- Only this computer's browsers are offered.
- Claude asks again for each new message, even if it used a browser earlier in the session, and even if you already named one in your message. Within one task (including its subagents) it does not ask again.
- If the task needs both browsers, Claude asks one multi-select question.
- Subagents cannot ask you. Claude asks in the main chat first, then hands the chosen browser to the subagent.
- Browser tools stay blocked until you choose. A hook enforces this, so it holds even if Claude forgets to ask.
- `switch_browser`, which pings every browser on every computer, is always blocked.

### Manage the list

```bash
node "<plugin folder>/scripts/browser-probe.js" list
node "<plugin folder>/scripts/browser-probe.js" remove <deviceId>
```

The registry file is plain JSON, so you can also edit it by hand. Claude knows the script path from the session context: you can just ask it to list or remove a browser.

## Settings

Optional file: `~/.claude/pickwise/config.json`. Any key you leave out keeps its default:

```json
{
  "model": {
    "enabled": true,
    "gatedModels": ["fable"],
    "fallbackModel": "opus",
    "approvalMinutes": 10,
    "routing": {
      "haiku": "search, locate code, list files, read and summarize, 1-2 file mechanical edits, web fetch",
      "sonnet": "implement from a clear plan, write tests, code review, audits, most multi-file work",
      "opus": "architecture, hard debugging, security review, writing plans, tasks where sonnet already failed"
    }
  },
  "browser": {
    "enabled": true,
    "probePort": 47831
  }
}
```

- To use only one part, set `"enabled": false` for the other.
- `gatedModels` matches parts of the model name: `"fable"` gates any Fable model. You can add `"opus"` to gate Opus too; then set `fallbackModel` to `"sonnet"`.
- Start a new session after you change the file.

Optional, recommended: in `~/.claude/settings.json`, give subagents a default model for the case where Claude forgets to set one:

```json
{ "env": { "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" } }
```

## Update and uninstall

```bash
claude plugin marketplace update extracool   # fetch the latest version
claude plugin update pickwise@extracool

claude plugin uninstall pickwise@extracool
```

Uninstalling leaves your data in `~/.claude/pickwise/`. Delete that folder if you no longer need it.

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing changes after install | Start a new session (VS Code: Reload Window). Hooks load at session start. |
| Fable runs with no question | Check `node --version` in the terminal. Check `claude plugin list` shows pickwise enabled. Check `config.json` does not set `"model": {"enabled": false}`. |
| You picked "Use Fable" but Claude is still denied | The approval lasts 10 minutes and allows one call. Ask again. |
| "no browser picked by the user is selected" or "the user has not picked this browser" | Pick a browser when Claude asks. The choice resets on every new message. If none is listed, register this computer's browsers first. |
| Registering finds nothing | Check the extension is connected in that browser and that nothing else uses port 47831; if it does, set `probePort`. |
| You had your own rules for this | Remove your own hooks from `~/.claude/settings.json` and your own rules from `CLAUDE.md`. Two approval guards would each consume the one-time approval. |

## How it works

| Part | What it does |
|---|---|
| `SessionStart` hook | Adds the model rules and this computer's browser list to Claude's context. |
| `PreToolUse` hook on `Agent`, `Task`, `Workflow` | Denies a gated model unless there is a fresh one-time approval. The deny message tells Claude to ask you. |
| `UserPromptSubmit` hook | Clears the browser choice on every new message, so each task asks again. |
| `PostToolUse` hook on `AskUserQuestion` | When you answer **Use Fable**, it writes the one-time approval. When your answer names a registered browser, it records that pick for the current task. Both live in `~/.claude/pickwise/state/`. |
| `PreToolUse` hook on `mcp__claude-in-chrome__*` | Blocks `switch_browser`. Blocks `select_browser` for unregistered browsers (except while the probe runs) and for browsers you did not pick in the current task. Blocks other browser tools until a picked browser is selected. |
| `PostToolUse` hook on `select_browser` | Remembers the selected browser until your next message. |
| `scripts/browser-probe.js` | The localhost probe and registry tool. |
| Skills `/pickwise:model`, `/pickwise:browser` | The full rules and the registration steps, for Claude and for you. |

Everything stays on your computer. The only network use is the probe on `127.0.0.1`.

Run the tests (Node.js only, they use a temporary home folder):

```bash
node tests/pickwise.test.js
```

---

## ภาษาไทย

**pickwise** คือ plugin สำหรับ Claude Code ทำโดย **ExTraCooL** ช่วยแก้ 2 ปัญหา:

1. **ให้ subagent ใช้ model ที่เหมาะกับงาน** เดิมทีถ้าไม่ได้ระบุ model ไว้ subagent จะใช้ model เดียวกับแชทหลัก ทำให้งานง่ายๆ ช้าและแพง pickwise ให้ Claude เลือก haiku, sonnet หรือ opus ตามงานเอง ส่วน **Fable** ต้องได้รับอนุมัติจากคุณในแชทก่อนเสมอ โดย Claude จะถามพร้อม 3 ตัวเลือก:
   - **Use Opus instead (Recommended):** ทำงานต่อด้วย Opus ทันที
   - **Use Fable:** ใช้ Fable 1 ครั้ง
   - **Cancel:** ยกเลิกงานนั้น
2. **ใช้เฉพาะ browser ของเครื่องที่ทำงานอยู่** Claude in Chrome จะแสดง browser ทุกตัวในบัญชีเป็น "Browser 1, 2, 3..." โดยไม่บอกว่าอยู่เครื่องไหน และชื่อก็เปลี่ยนไปเรื่อยๆ pickwise จะเก็บรายชื่อ browser แยกตามเครื่อง และถามทุกครั้งที่เริ่มงานใหม่ว่าจะใช้ Edge หรือ Chrome ของเครื่องนี้ตัวไหน

### สิ่งที่ต้องมี

- Claude Code (CLI หรือ VS Code extension)
- Node.js 18 ขึ้นไป
- บน Windows ต้องมี Git for Windows
- สำหรับส่วน browser ต้องมี Claude in Chrome extension

### ติดตั้ง (Terminal)

พิมพ์ใน Claude Code:

```
/plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin
/plugin install pickwise@extracool
```

หรือรันใน shell: `claude plugin marketplace add tatar-alphaagency/extracool-pickwise-claude-plugin` แล้วตามด้วย `claude plugin install pickwise@extracool`

หลังติดตั้ง ให้ **เปิด session ใหม่**

### ติดตั้ง (VS Code)

1. เปิด terminal ใน VS Code แล้วรันคำสั่ง `claude plugin ...` 2 บรรทัดด้านบน VS Code extension กับ CLI ใช้โฟลเดอร์ `~/.claude` ร่วมกัน ติดตั้งครั้งเดียวจึงใช้ได้ทั้งสองที่
2. กด `Ctrl+Shift+P` แล้วเลือก **Developer: Reload Window** หรือเปิดแชท Claude ใหม่
3. คำถามของ pickwise จะขึ้นเป็นหน้าต่างตัวเลือกในแผง Claude

### ใช้งาน

- **model:** ไม่ต้องทำอะไรเพิ่ม Claude เลือก model เอง ส่วน Fable จะถามก่อนทุกครั้ง
- **browser ครั้งแรกบนแต่ละเครื่อง:** พิมพ์ว่า "ลงทะเบียน browser ของเครื่องนี้" Claude จะเปิดแท็บทดสอบที่ `127.0.0.1:47831` ใน browser แต่ละตัว ตัวที่เปิดได้คือ browser ของเครื่องนี้ แล้วบันทึกไว้ที่ `~/.claude/pickwise/browsers/<ชื่อเครื่อง>.json`
- **ทุกงาน:** ทุกข้อความใหม่ที่คุณส่งนับเป็นงานใหม่ ก่อนใช้ browser ครั้งแรกในงานนั้น Claude จะถามว่าจะใช้ browser ตัวไหนของเครื่องนี้ ถามซ้ำแม้เคยใช้ไปแล้วใน session หรือแม้คุณระบุชื่อ browser มาในข้อความแล้ว ภายในงานเดียวกัน (รวม subagent) จะไม่ถามซ้ำ hook บังคับเรื่องนี้ จึงยังทำงานแม้ Claude ลืมถาม

### ตั้งค่า

แก้ไฟล์ `~/.claude/pickwise/config.json` ดูรายละเอียดที่หัวข้อ [Settings](#settings)

- ปิดส่วนใดส่วนหนึ่ง: ตั้ง `"enabled": false`
- เปลี่ยน model ที่ต้องขออนุมัติ: แก้ `gatedModels`
- เปลี่ยน model ที่ใช้แทน: แก้ `fallbackModel`

แก้แล้วต้องเปิด session ใหม่

### ถอนการติดตั้ง

```bash
claude plugin uninstall pickwise@extracool
```

---

MIT License © 2026 ExTraCooL
