# Desktop shell (macOS and Windows)

The shell is a thin Tauri 2 window that loads the GUI from the relay and adds native deep-link launch for Reply. It contains no web UI; the relay origin is baked in at configure time.

Prerequisites: Rust stable (rustup), Bun, and on Windows the WebView2 runtime (bundled with Windows 11) plus NSIS (installed by the Tauri CLI on first build).

```sh
cd packages/shell
INBOX_RELAY_URL=https://inbox.example.net bun run configure   # writes src-tauri/tauri.conf.json and capabilities/remote.json
bun run build                                                 # macOS: Inbox.app + .dmg; Windows: NSIS installer
# development against a local relay (start `bun run dev` at the repository root first):
INBOX_RELAY_URL=http://localhost:8787 bun run configure && bun run dev
```

Output lands in `packages/shell/src-tauri/target/release/bundle/` (`macos/Inbox.app`, `dmg/Inbox_<version>_<arch>.dmg`, `nsis/Inbox_<version>_x64-setup.exe`).

Environment variables read by `bun run configure` and the Tauri bundler:

| Variable | Used for |
|---|---|
| `INBOX_RELAY_URL` | Required. The relay origin (`https://host`, or `http://localhost:8787` in development). Becomes the window URL and the only origin allowed to call the shell's commands. |
| `APPLE_SIGNING_IDENTITY` | macOS code signing identity, e.g. `Developer ID Application: Your Name (TEAMID)`. Unset means an unsigned (ad-hoc) build. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarization with an Apple ID and an app-specific password; Tauri submits and staples automatically when these are set with the signing identity. |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | Alternative notarization with an App Store Connect API key. |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | SHA-1 thumbprint of a code-signing certificate in the Windows certificate store. |
| `WINDOWS_SIGN_COMMAND` | Alternative: a custom signing command with a `{{path}}` placeholder (for example a cloud signing service). |

The window may navigate only to the relay origin and to slack.com (the Slack authorization round trip happens in the same window); every other link opens in the default browser. The two commands the GUI may call, from the relay origin only: `platform()` and `open_deep_link(native, web)`.

To regenerate the icon set from a new 1024x1024 PNG: `bunx tauri icon path/to/icon.png -o src-tauri/icons` (delete the android/ and ios/ folders it adds).

Unverified at build time: the Windows build, installer and signing (no Windows machine), and macOS signing and notarization (no identity set). The debug build on this Mac produced `Inbox.app` and a `.dmg`.
