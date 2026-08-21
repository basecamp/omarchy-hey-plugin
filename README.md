# HEY email for Omarchy

A Quickshell bar plugin that shows unread and recent email from your HEY Imbox through the [HEY CLI](https://github.com/basecamp/hey-cli).

![HEY email panel for Omarchy](preview.png)

## Features

- Shows unseen Imbox email from every linked HEY account.
- Switches between accounts with a dropdown that shows the unread count per account.
- Splits email into `New for you` and `Previously seen` tabs.
- Shows the pending Screener count without including it in the unread count.
- Toasts new Imbox mail when you turn notifications on — one notification per poll at most, replaced rather than stacked, silenced by Omarchy's notification toggle.
- Shows sender initials in a colored avatar on each email row.
- Opens email topics in HEY and marks unseen postings as seen.
- Changes the bar logo color when unseen email exists.
- Polls every 10 minutes. Right-click or middle-click the bar logo to refresh immediately; `hey tui` refreshes it the moment you archive or mark a thread.

## Requirements

- Omarchy with Quickshell plugin support.
- [HEY CLI](https://github.com/basecamp/hey-cli) 0.2.0 or newer — the plugin runs its `hey omarchy poll` command. It is on the AUR:

  ```bash
  omarchy pkg aur add hey-cli
  ```

- An authenticated HEY CLI login.

When the HEY CLI is missing or signed out, the panel shows a setup button. Click it to run the install or sign-in in a floating terminal. The panel detects completion on its own. You can also copy the shown command and run it yourself. An older CLI without `hey omarchy poll` is reported in the panel header.

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

## Notifications

Off by default. The switch in the panel header turns new-mail toasts on; so do `hey setup omarchy --notify` and `omarchy bar set 37signals.hey notify true --json` — all three flip the `notify` key on the plugin's entry in `~/.config/omarchy/shell.json`, which the shell hot-reloads.

When on, the plugin passes `--notify` to `hey omarchy poll` and the CLI sends the toast itself through `omarchy-notification-send`:

- At most one toast per poll — `Sender — Subject` for one new thread, `N new in Imbox` with the first few senders for more — replacing the previous toast rather than stacking.
- New means a thread you have not been told about, or a known unseen thread that grew; muted threads never toast. The first poll after turning notifications on seeds silently, so the backlog is never toasted.
- The toast identifies as HEY, so SUPER+CTRL+comma (Omarchy's notification silencing) mutes it like any other app. Clicking it focuses `hey tui`.
- On a multi-monitor desktop every bar instance polls, but the CLI serializes the diff under a lock, so one new thread is one toast.

## Privacy and security

The plugin runs these local CLI commands:

```text
hey auth status --json
hey accounts list --json
hey omarchy poll --account all --limit <count> [--notify] --json
hey screener list --count --json
hey seen <posting-id> --json
flock -n $XDG_RUNTIME_DIR/37signals.hey.setup.lock true
```

Email data is held in the Quickshell process memory. The plugin does not write email content, credentials, or tokens to disk, and never handles a token at all. With notifications on, the CLI keeps the fingerprints of the unseen threads it has already announced in `~/.local/state/hey-cli/omarchy-poll.json` — thread ids and reply counts, no content — and forgets them when notifications are turned off.

## License

MIT
