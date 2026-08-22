# HEY email for Omarchy

A Quickshell bar plugin that shows unread and recent email from your HEY Imbox through the [HEY CLI](https://github.com/basecamp/hey-cli).

![HEY email panel for Omarchy](preview.png)

## Features

- Shows unseen Imbox email from every linked HEY account.
- Switches between accounts with a dropdown that shows the unread count per account.
- Splits email into `New for you` and `Previously seen` tabs.
- Shows the pending Screener count without including it in the unread count.
- Updates live: the panel and the logo follow your Imbox as it changes, over HEY's own change feed — a thread you archive in `hey tui`, on your phone or in the web app leaves the panel within a second.
- Toasts new mail when you turn notifications on — one notification per batch of changes at most, replaced rather than stacked, silenced by Omarchy's notification toggle.
- Shows sender initials in a colored avatar on each email row.
- Opens email topics in HEY and marks unseen postings as seen.
- Changes the bar logo color when unseen email exists.
- Re-reads the Imbox every 10 minutes as a safety net. Right-click or middle-click the bar logo to refresh immediately.

## Requirements

- Omarchy with Quickshell plugin support.
- [HEY CLI](https://github.com/basecamp/hey-cli) 0.2.0 or newer — the plugin runs `hey box imbox` and `hey watch --events …,new,resync`, whose lines say which threads are new mail. It is on the AUR:

  ```bash
  omarchy pkg aur add hey-cli
  ```

- An authenticated HEY CLI login.

When the HEY CLI is missing or signed out, the panel shows a setup button. Click it to run the install or sign-in in a floating terminal. The panel detects completion on its own. You can also copy the shown command and run it yourself. An older CLI without `hey watch` is reported in the panel header.

Authenticate and confirm that the CLI can see your Imbox:

```bash
hey auth login
hey box imbox
```

The plugin uses the CLI's existing credential store. Credentials stay managed by the HEY CLI; the plugin never reads a token.

## Installation

Install and enable the published repository with:

```bash
omarchy plugin add https://github.com/basecamp/omarchy-hey-plugin.git --enable
```

For a local checkout, pass its path instead:

```bash
omarchy plugin add ~/code/basecamp/omarchy-hey-plugin --enable
```

The plugin manifest declares the right bar section as its default placement.

## Usage

- Left-click the HEY logo to open or close the panel.
- Right-click or middle-click the logo to refresh.
- Select `New for you` or `Previously seen` below the account dropdown.
- Pick an account from the dropdown when more than one account is linked. A dot on the dropdown shows unread email in other accounts.
- Click an email to open it in HEY and mark it as seen. Click the count badge to mark it as seen without opening it.
- Use the up and down arrow keys to move through email. Use the left and right arrow keys to cycle accounts.
- Press `U` for new email, `P` for previously seen email, `S` for the Screener, `N` to toggle notifications, or `R` to refresh.

## Live updates

The plugin is an Omarchy service as well as a bar widget: the shell starts it once, and every bar — one per monitor — reads that one instance, so one `hey watch` runs per shell. `hey --account all watch --events added,updated,deleted,new,resync` follows every HEY box of every linked account over HEY's cable — a persisted `hey accounts use` filter cannot hide changes from the panel — and prints a line per change; the plugin treats any line as a wake-up and re-reads the Imbox, debounced so a burst of changes costs one read (plus one follow-up when changes land while a read is in flight). The watch says `ready` once it is listening, and again after it catches up from a disconnect — a suspended laptop, a dropped network — and the read on that line is what keeps the panel gap-free and current within seconds of coming back. The 10-minute re-read stays only as a safety net.

The bar logo's tooltip says `live` while the watch has said `ready` and not `disconnected` since. When the watch stops for a reason other than being signed out, the panel header says so and the plugin restarts it on a backoff (two seconds, doubling to a minute); signed out, it waits for you to sign in again.

## Notifications

Off by default. The switch in the panel header turns new-mail toasts on; so do `hey setup omarchy --notify` and `omarchy bar set 37signals.hey notify true --json` — all three flip the `notify` key on the plugin's entry in `~/.config/omarchy/shell.json`, which the shell hot-reloads. Flipping it only gates the toasts; the watch runs on, and nothing restarts.

Every `added` and `updated` line `hey watch` writes says whether the thread is new mail — unseen, unmuted, and active since the watch last saw it, or since the watch began for a thread it has not seen, so a box's backlog is never new and neither is reading, muting or moving a thread, while a reply on a known thread is. That is the CLI's call, made once on HEY's own clock. The plugin reads those lines for the Imbox — the watch follows every box, but only Imbox mail asks for attention — and sends the toast itself through `omarchy-notification-send`:

- At most one toast per burst of changes — `Sender — Subject` for one new thread, `N new in Imbox` with the first few senders for more — replacing the previous toast rather than stacking (the daemon's printed id is kept for ten minutes and passed back as `-r`).
- The toast identifies as HEY, so SUPER+CTRL+comma (Omarchy's notification silencing) mutes it like any other app. Clicking it focuses `hey tui`.
- One watch per shell means one toast per burst, however many monitors. Nothing is written to disk.

## Privacy and security

The plugin runs these local CLI commands:

```text
hey --version
hey auth status --json
hey accounts list --json
hey box imbox --account all --limit <count> --json
hey --account all watch --events added,updated,deleted,new,resync
hey screener list --count --json
hey seen <posting-id> --json
flock -n $XDG_RUNTIME_DIR/37signals.hey.setup.lock true
omarchy-notification-send --glyph <glyph> --app-name HEY -u low --exec "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui" <headline> [description] -p [-r <id>]
```

`hey watch` is run under `setpriv --pdeathsig TERM`, so it ends with the shell that started it. Email data is held in the Quickshell process memory. The plugin does not write email content, credentials, or tokens to disk, and never handles a token at all; the watch keeps no state file either.

## License

MIT
