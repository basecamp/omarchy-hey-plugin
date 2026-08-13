# HEY email for Omarchy

A Quickshell bar plugin that shows unread and recent email from your HEY Imbox through the [HEY CLI](https://github.com/basecamp/hey-cli).

![HEY email panel for Omarchy](preview.png)

## Features

- Shows unseen Imbox email by default.
- Shows the pending Screener count without including it in the unread count.
- Switches between unseen and recent email.
- Opens email topics in HEY and marks unseen postings as seen.
- Changes the bar logo color when unseen email exists.
- Polls every 10 minutes. Right-click or middle-click the bar logo to refresh immediately.

## Requirements

- Omarchy with Quickshell plugin support.
- A current [HEY CLI](https://github.com/basecamp/hey-cli) build with the `seen` command.
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
- Select `Unread` or `All` below the HEY title.
- Click an email to open it in HEY and mark it as seen.
- Use the up and down arrow keys to move through email.
- Press `U` for unseen email, `A` for all loaded email, or `R` to refresh.

## Privacy and security

The plugin runs these local CLI commands:

```text
hey box imbox --limit <count> --json
hey seen <posting-id> --json
hey auth token --quiet
curl https://app.hey.com/clearances.json
```

Email data is held in the Quickshell process memory. The Screener count comes from HEY's authenticated `/clearances.json` endpoint because the CLI does not yet expose it directly. The access token is passed in process memory and is not written to disk. The plugin does not write email content, credentials, or tokens to disk.

## License

MIT
