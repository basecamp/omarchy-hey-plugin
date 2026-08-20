# HEY email for Omarchy

A Quickshell bar plugin that shows unread and recent email from your HEY Imbox through the [HEY CLI](https://github.com/basecamp/hey-cli).

![HEY email panel for Omarchy](preview.png)

## Features

- Shows unseen Imbox email from every linked HEY account.
- Switches between accounts with a dropdown that shows the unread count per account.
- Splits email into `New for you` and `Previously seen` tabs.
- Shows the pending Screener count without including it in the unread count.
- Shows sender initials in a colored avatar on each email row.
- Opens email topics in HEY and marks unseen postings as seen.
- Changes the bar logo color when unseen email exists.
- Polls every 10 minutes. Right-click or middle-click the bar logo to refresh immediately.

## Requirements

- Omarchy with Quickshell plugin support.
- A current [HEY CLI](https://github.com/basecamp/hey-cli) build with the `seen` and `accounts` commands. With an older CLI, the plugin still works but hides the account switcher.

When the HEY CLI is missing or signed out, the panel shows the setup step to run. Click the command to copy it, run it in a terminal, and press `R` in the panel to retry.
- An authenticated HEY CLI login.

The current HEY CLI requires Go 1.26 or newer. Until a current package is published, install it from source using the CLI's supported installation process:

```bash
git clone https://github.com/basecamp/hey-cli.git
cd hey-cli
mise install
make install
```

`make install` builds the CLI and installs `hey` into `/usr/local/bin`.

Authenticate and confirm that the CLI can see your Imbox:

```bash
hey auth login
hey box imbox
```

The plugin uses the CLI's existing credential store. Credentials remain managed by the HEY CLI, and the access token used to request the Screener count remains in process memory.

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
- Press `U` for new email, `P` for previously seen email, `S` for the Screener, or `R` to refresh.

## Privacy and security

The plugin runs these local CLI commands:

```text
hey accounts list --json
hey box imbox --account all --limit <count> --json
hey seen <posting-id> --json
hey auth token --quiet
curl https://app.hey.com/clearances.json
```

Email data is held in the Quickshell process memory. The Screener count comes from HEY's authenticated `/clearances.json` endpoint because the CLI does not yet expose it directly. The access token is passed in process memory and is not written to disk. The plugin does not write email content, credentials, or tokens to disk.

## License

MIT
