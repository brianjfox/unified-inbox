# Open product decisions

Record here any product decision the documents leave unresolved, with the choice it blocks. Do not choose silently.

Each entry below names the gap, the behavior the build has in place so work could continue, and what changes if you decide otherwise. Nothing here was chosen silently; each needs your confirmation or correction.

## 1. Bootstrapping the first viewer's approval

**Gap.** The build plan's installation step says a new device is enrolled with "approval shown on an already-enrolled device." The connector hub is enrolled first, but it has no screen, so the very first viewer has no approver.

**Behavior in place.** The connector hub approves the first viewer automatically when no approved viewer exists yet, wrapping the inbox key for it. Every later viewer appears as pending on the Connections screen's Sync card of an approved viewer, which approves or declines it. The first hub to enroll is approved by the relay itself (it generates the inbox key).

**If you decide otherwise.** A one-time pairing code printed by the hub installer, or approval from the hub's own log, replaces the auto-approval of the first viewer.

## 2. Slack Socket Mode needs an app-level token

**Gap.** The build plan's Slack connector receives messages over Socket Mode, which Slack only offers to an app with an app-level token (`xapp-…`, scope `connections:write`). The design's one-time Slack app settings show a client ID and client secret only.

**Behavior in place.** The Slack app settings panel takes three values: client ID, client secret, and app-level token. All three are sealed to the hub and stored in the Mac keychain like the tokens (FR-25). The Slack app must have Socket Mode enabled and subscribe to the user events `message.im` and `message.mpim`; the panel's help text and the user manual say so.

**If you decide otherwise.** Polling Slack instead of Socket Mode removes the third field but adds per-conversation history calls on a timer and makes delivery depend on Slack's rate limits.

## 3. iMessage read-back resolved to the approved fallback without a live spike

**Gap.** Task 6 planned to spike both read-back routes against Messages. At build time this machine had no Full Disk Access, so neither route could be exercised live.

**Behavior in place.** Opening an iMessage conversation marks it read in the unified view and across machines; the Messages badge is left untouched, as the approved fallback allows (ADR-6, AC-5 amendment). By inspection: Messages scripting exposes no mark-read verb, and writing `is_read` into chat.db while Messages owns the file risks being overwritten by iCloud sync or corrupting the database. The Connections screen's iMessage card and the user manual state the limitation.

**If you decide otherwise.** With Full Disk Access granted on the hub Mac, the database-write route can be spiked for real; if it proves safe, read-back becomes per conversation and this entry closes.

## 4. The connector hub runs on Node, not Bun

**Gap.** The build plan names Bun as the connector hub's runtime and better-sqlite3 as its SQLite library. better-sqlite3 does not load under Bun (Bun refuses its native module: "'better-sqlite3' is not yet supported in Bun"), so the two cannot both be honored.

**Behavior in place.** The connector hub, the seed script and their tests run on Node 26 (installed here), which executes TypeScript natively, with better-sqlite3 as named. The relay, the GUI build and the dev script run on Bun as planned. This is an implementation-strategy finding, not a product change; the build plan should be amended to record it.

## 5. Component names in the design do not exist in the UI kit

**Gap.** The design and PRD name `@corbits/react-ui` components `AppShell`, `NavList`, `ListView`, `Tag`, `Banner` and `StatusPill`. Version 0.3.0 of the kit has none of these.

**Behavior in place.** The GUI uses the kit's real components where they fit (`Sidebar`, `SidebarItem`, `ListDetail`, `Badge`, `Card`, `EmptyState`, `Skeleton`, `Button`, `Input`, `StatusDot`) and small local components, styled from the approved design, for the service tag, the banner and the status pill. Every `data-testid`, state and piece of copy follows the design.

## 6. Unverified at build time, for lack of credentials or hardware

Not decisions, but gaps you should know about before relying on the acceptance checklist:

- No Slack app, WhatsApp scan, or Full Disk Access existed on the build machine, so AC-2 through AC-5, AC-9, AC-13, AC-14, AC-16 and AC-17 could not be run against live accounts here. The connectors fail with clear errors naming the missing credential until you add it on the Connections screen.
- No Windows machine or Windows code-signing certificate was available, so the Windows shell build, its signature, and the Windows halves of AC-11 and AC-21 are unverified.
- The DigitalOcean provisioning script was not run against a real droplet or host from this machine, so AC-P4's live round-trip is unverified. Its two parameter paths were exercised in dry-run mode only.
- The macOS reboot drill (AC-1) and the phone-browser pass (AC-28) need your hands.

## 7. Small connector choices made during the build

Each is the smallest reading of the documents; say so if you want a different one.

- **iMessage tapbacks are skipped.** Messages stores reactions ("Loved …", "Liked …") as message rows; the inbox skips them so a reaction never shows as a message, matching how Messages itself displays them.
- **iMessage names come from Messages, not Contacts.** A one-to-one chat is named by its handle (phone number or email) unless Messages has a display name. Reading Contacts needs a second permission grant and is not in the documents.
- **WhatsApp history on first link.** The messages WhatsApp sends when a device first links are ingested within the 14-day window, so a fresh link shows recent chats rather than an empty list.
- **WhatsApp relink logs the old device out first**, so the phone's linked-device list stays accurate (FR-4).
- **Slack names prefer the display name**, then the real name, then the handle. Slack's `team.info` call is not made because it needs a scope the design does not list; the workspace name and domain come from `auth.test`.
- **Transient states show as "error" with a since-time.** The status schema has no "connecting" state, so Slack's Socket Mode connect window and WhatsApp's reconnect after a restart report `error` with a detail line saying they are connecting. Adding a `connecting` state would be a one-line schema change plus a card variant.
- **A Slack message with only files** gets the body "Sent a file" so its preview is not blank.
