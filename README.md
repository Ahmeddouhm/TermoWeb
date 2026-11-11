# TermoWeb

A local web terminal for Windows. It runs a real `cmd.exe` or `powershell.exe` session and shows it in your browser, with correct Arabic (RTL / BiDi) rendering, Linux-style command aliases, and tab completion.

## Why

Mixed Arabic and English text is often rendered badly in the standard Windows console: reversed punctuation, broken letter joining, awkward cursor movement. TermoWeb renders output as ordinary DOM text, so the browser handles Arabic shaping and bidirectional layout natively. It also lets you use common Linux commands (`ls`, `cat`, `grep`, …) and Arabic command names without installing WSL or Git Bash.

## Features

- **Arabic and BiDi support.** Each line picks its own direction (`dir="auto"`, `unicode-bidi: plaintext`), so Arabic lines align right and English lines align left. The prompt path is isolated and always left-to-right, so it doesn't scramble next to Arabic input. The direction can also be forced to LTR or RTL from the header.
- **Real shells.** CMD and PowerShell (Windows PowerShell 5.1), switchable from the header. Both run in UTF-8.
- **Linux and Arabic aliases.** Commands are translated before they reach the shell. See [Command aliases](#command-aliases).
- **Tab completion.** Command names and file paths, with a suggestion list when there are several matches.
- **Interactive programs.** Anything that reads from stdin works, such as `dotnet run` with `Console.ReadLine()` or a Python script using `input()`, in Arabic or English.
- **Interrupt.** Ctrl+C stops the running program without closing the shell.
- **ANSI colors.** 16, 256 and 24-bit colors, plus bold, dim, italic, underline and inverse. A lone carriage return overwrites the current line, so progress indicators render correctly.
- **Themes.** Classic CMD, Matrix Green 0A, Blue PowerShell, Ubuntu Dark.
- **Saved preferences.** Shell, direction, theme, and the last 300 commands are kept in `localStorage`.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org/) 18 or newer
- An internet connection is optional. It is only used to load the Cairo and Cascadia Code fonts from Google Fonts; without it the page falls back to local fonts.

## Getting started

### One click

Double-click `start.bat`. It checks for Node.js, runs `npm install` on the first launch, starts the server, and opens `http://127.0.0.1:8080` in your browser.

### From the command line

```cmd
git clone https://github.com/Ahmeddouhm/TermoWeb.git
cd TermoWeb
npm install
npm start
```

Then open <http://127.0.0.1:8080>. Use `npm run open` to open the browser automatically.

### Configuration

| Setting | Description |
| :--- | :--- |
| `PORT` environment variable | Port to listen on. Default: `8080`. |
| `--open` flag | Open the default browser on startup. |

```cmd
:: CMD
set PORT=3000 && npm start

:: PowerShell
$env:PORT = "3000"; npm start
```

## Usage

### Keyboard shortcuts

| Key | Action |
| :--- | :--- |
| `Enter` | Run the command. If a program is waiting for input, send the text to it. |
| `↑` / `↓` | Previous / next command from history. |
| `Tab` | Complete the command or path. Press it again to cycle through the suggestions. |
| `Shift+Tab` | Cycle through suggestions backwards. |
| `Ctrl+C` | Copy if text is selected. Otherwise interrupt the running program, or discard the current input line if the shell is idle. |
| `Ctrl+L` | Clear the screen. |

The header also has buttons for **Ctrl+C (Kill/Interrupt)**, **Clear (CLS)** and **Reconnect** (starts a fresh shell session), and selectors for shell, text direction and color theme.

### Command aliases

Aliases are applied by the server to the first word of each pipeline stage (for example, `ls | grep test`). They are **not** applied while a running program is reading input, so text you type into a prompt is sent unchanged.

Arabic names are matched after normalizing diacritics, tatweel and letter variants (`أ`, `إ`, `آ` → `ا`; `ى` → `ي`).

**Linux aliases**

| Command | Flags handled | CMD | PowerShell |
| :--- | :--- | :--- | :--- |
| `ls` | `-a` `-R` `-t` `-S` `-1` (`-l`, `-h` ignored) | `dir` with `/a` `/s` `/o-d` `/o-s` `/b` | `Get-ChildItem` with `-Force` `-Recurse` |
| `ll` | same as `ls -a` | `dir /a` | `Get-ChildItem -Force` |
| `pwd` | | `cd` | native alias |
| `cat` | | `type` | native alias |
| `clear` | | `cls` | `cls` |
| `rm` | `-r` `-R` `-f` | `rmdir /s /q` or `del /q [/f]` | `Remove-Item [-Recurse] [-Force]` |
| `cp` | `-r` `-R` | `xcopy /e /i /y` or `copy /y` | `Copy-Item [-Recurse]` |
| `mv` | | `move /y` | native alias |
| `mkdir` | flags such as `-p` are dropped | `mkdir` | native |
| `grep` | `-i` `-n` `-v` `-r` | `findstr /i /n /v /s` | alias for `Select-String` (flags are not translated) |
| `which` | | `where` | alias for `Get-Command` |
| `touch` | | `type nul >> file` | function: creates the file or updates its timestamp |
| `man` | | `help` | native alias |

In CMD, forward slashes in path arguments of these commands are converted to backslashes (`./src/app.js` → `.\src\app.js`). URLs and `/switch` style arguments are left alone. In PowerShell, only the unix-style flags listed above are rewritten; native PowerShell parameters such as `-Force` pass through unchanged.

**Arabic aliases**

| Arabic | Same as | Arabic | Same as |
| :--- | :--- | :--- | :--- |
| `ملفات` | `ls` | `انسخ` | `cp` |
| `مسح` | `clear` | `انقل` | `mv` |
| `ادخل` | `cd` | `احذف` | `rm` |
| `شجرة` | `tree` | `انشئ` | `mkdir` |
| `اقرأ` | `cat` | `مكاني` | `pwd` |
| `خروج` | `exit` | | |

### Tab completion

- **Command names:** the aliases above, CMD or PowerShell built-ins, and executables found on `PATH` (the `PATH` scan is cached for 30 seconds).
- **Paths:** relative to the shell's current directory. Quote-aware, handles spaces and Arabic names, and expands a leading `~\`. Folders get a trailing separator so you can keep completing. `cd`, `ادخل`, `rmdir`, `pushd` and similar commands only suggest folders.
- **Spaces in names:** the path is quoted automatically. For folders the cursor stays inside the closing quote so you can continue completing.
- **Multiple matches:** the first Tab fills in the shared prefix. If nothing more can be added, the next Tab lists the options and further presses cycle through them.
- **Not covered:** flags and PowerShell parameter completion (`-Rec` → `-Recurse`).

## How it works

```text
Browser (index.html)  <-- WebSocket (token-authenticated) -->  Node.js (server.js)  <-- pipes -->  cmd.exe / powershell.exe
```

- The server spawns the shell with piped stdin/stdout/stderr and forwards output to the browser. The shell does not echo piped input, so the browser echoes what you type.
- **Encoding.** CMD is started with `chcp 65001`, PowerShell's console encodings are set to UTF-8 (without BOM), and `PYTHONUTF8` / `PYTHONIOENCODING` are set so Python output is UTF-8.
- **Prompt and working directory.** Both shells print a hidden marker carrying the current directory. The server strips it from the output and the page uses it to update the prompt label, so paths with Arabic characters are handled reliably.
- **Aliases are translated on the server.** `doskey` macros don't work when the shell reads from a pipe, which is why the translation happens before the line is sent.
- **Interrupt.** Windows has no way to send a Ctrl+C signal through a pipe, so the server finds the shell's child processes (`Get-CimInstance Win32_Process`) and ends them with `taskkill /T /F`. The shell and its console host are left running.
- **Rendering.** Output is rendered as DOM elements, not on a canvas, which is what gives native Arabic shaping and bidirectional layout.

## Security

A web page that can run shell commands needs to be locked down. TermoWeb does the following:

- Listens on `127.0.0.1` only.
- Generates a random 192-bit token on every start, injects it into the served page, and requires it on the WebSocket connection (compared in constant time). A wrong token closes the connection with code `1008`.
- Checks the `Host` and `Origin` headers on HTTP requests and WebSocket upgrades, which blocks other websites from connecting to the local port and protects against DNS rebinding.
- Sends a restrictive `Content-Security-Policy`, plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- Allows at most 8 concurrent sessions.

Other users on the same Windows machine can still reach the local port, and anyone who can request the page can obtain the token. Don't run TermoWeb on a shared machine. Commands run with the permissions of the user who started the server.

## Limitations

- **Not a full terminal emulator.** The shell is attached through pipes, not a pseudo-terminal. Full-screen programs (`vim`, `nano`, `more`, `top`) don't work, and programs that detect a TTY may buffer output or disable colors.
- **Interrupt scope.** Ctrl+C ends child processes. A PowerShell cmdlet running inside the shell itself (for example `Start-Sleep`) can't be interrupted this way; use **Reconnect** to restart the session.
- **Arabic input to programs.** Output and display are fully supported. Arabic text typed into a running program depends on how that program reads the console input code page. If a specific program mangles it, please open an issue.
- **PowerShell.** `powershell.exe` (5.1) is started with `-NoProfile`, so your profile isn't loaded. PowerShell 7 (`pwsh`) is not used.
- **Windows only.** The server exits with a message on other operating systems.

## Troubleshooting

**"Session token is no longer valid"**
The server was restarted while the tab was open. Press **Reconnect** (or refresh the page) to load the new token.

**"Port 8080 is already in use"**
Start on another port: `set PORT=8085 && npm start`.

**Fonts look different offline**
Cairo and Cascadia Code are loaded from Google Fonts. Offline, the page uses Consolas and a system Arabic font. Arabic still renders and joins correctly.

**A command isn't translated**
Aliases only apply to the first word of a command or pipeline stage, and not while a program is waiting for input.

## Project structure

```text
.
├── index.html         Frontend: UI, BiDi styling, ANSI parser, history, tab completion
├── server.js          Backend: HTTP + WebSocket server, shell sessions, alias translation, completion
├── package.json
├── package-lock.json
├── start.bat          One-click launcher
└── README.md
```

## Contributing

Bug reports and pull requests are welcome. Fork the repository, create a branch, and open a pull request describing the change. When reporting a bug, include your Windows version, Node.js version, the shell you were using, and the exact command you ran.

## License

MIT
