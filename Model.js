// One place for the setup-state UI contract: which state wins (missing CLI
// beats signed-out), the user-facing strings, and the exact shell command
// the panel launches in a floating terminal. The launch command preserves
// the fix's exit status through the IPC refresh so the terminal
// presentation can honor Ctrl-C (exit 130) from the fix itself.
var setupLockDirectoryName = "setup-lock"
var setupLockShell = "uid=$(id -u) || exit 76; "
  + "runtime=${XDG_RUNTIME_DIR:-/run/user/$uid}; "
  + "[ -d \"$runtime\" ] && [ ! -L \"$runtime\" ] "
  + "&& [ \"$(stat -c %u -- \"$runtime\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& [ \"$(stat -c %a -- \"$runtime\" 2>/dev/null)\" = 700 ] || exit 76; "
  + "ensure_private_dir() { path=$1; "
  + "if mkdir -m 700 -- \"$path\" 2>/dev/null; then return 0; fi; "
  + "[ -d \"$path\" ] && [ ! -L \"$path\" ] "
  + "&& [ \"$(stat -c %u -- \"$path\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& chmod 700 -- \"$path\"; }; "
  + "umask 077; base=\"$runtime/37signals.hey-$uid\"; "
  + "ensure_private_dir \"$base\" || exit 76; "
  + "lock=\"$base/" + setupLockDirectoryName + "\"; "
  + "ensure_private_dir \"$lock\" || exit 76; "

function setupLockCheckCommand() {
  return ["bash", "-c", setupLockShell + "exec 9<\"$lock\"; flock -n 9"]
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function setupLaunchCommand(fix, ipcTarget) {
  var target = shellQuote(ipcTarget)
  var completion = "omarchy-shell -q \"$target\" setupFinished"
  return "target=" + target + "; " + setupLockShell
    + "( flock -n 9 || { printf '%s\\n' 'HEY setup is already running.'; exit 75; }; "
    + "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; "
    + "trap 'rc=$?; trap - EXIT; flock -u 9; " + completion + "; exit $rc' EXIT; "
    + String(fix || "") + " ) 9<\"$lock\""
}

function setupPlan(installed, authenticated, ipcTarget) {
  var plan = {
    needed: installed !== true || authenticated !== true,
    title: "Please sign in",
    command: "hey auth login --json >/dev/null",
    buttonLabel: "Sign in to HEY…",
    fix: "hey auth login --json >/dev/null"
  }
  if (installed !== true) {
    plan.title = ""
    plan.command = ""
    plan.buttonLabel = "Install HEY CLI…"
    plan.fix = "omarchy-mise-install github:basecamp/hey-cli hey && hey auth login --json >/dev/null"
  }
  plan.launchCommand = setupLaunchCommand(plan.fix, ipcTarget)
  return plan
}

// Every captured process has an independent producer-side byte ceiling. The
// extra byte lets the consumer distinguish a response exactly at the limit
// from one that was cut off. JSON entry points enforce the same ceiling again
// before parsing.
var cliResponseByteLimit = 1024 * 1024
var cliErrorByteLimit = 64 * 1024
var probeResponseByteLimit = 64 * 1024
var finiteCommandTimeoutSec = 30
var finiteCommandKillGraceSec = 2
var watchOutputByteLimit = 4 * 1024 * 1024
var watchLineByteLimit = 64 * 1024
var maximumAccountCount = 32
var maximumPostingCount = 50
var maximumToastPostings = 50

var remoteIdCharacterLimit = 64
var remoteNameCharacterLimit = 160
var remoteTitleCharacterLimit = 256
var remoteExcerptCharacterLimit = 512
var remoteUrlCharacterLimit = 2048
var remoteTimestampCharacterLimit = 64
var remoteTypeCharacterLimit = 64
var remoteCountCharacterLimit = 20
var remoteCountMaximum = 999999
var remoteErrorCharacterLimit = 512
var remoteHintCharacterLimit = 512
var remoteCodeCharacterLimit = 64

var boundedCaptureScript = "stdout_limit=$1; stderr_limit=$2; deadline=$3; grace=$4; shift 4; child_pid=; timer_pid=; killer_pid=; timed_out=0; "
  + "stop_timer() { if [ -n \"$timer_pid\" ]; then kill -TERM -- \"-$timer_pid\" 2>/dev/null || true; kill -TERM \"$timer_pid\" 2>/dev/null || true; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; fi; }; "
  + "start_group_killer() { setpriv --pdeathsig KILL setsid bash -c 'end=$((SECONDS + $1)); while kill -0 -- \"-$2\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; kill -KILL -- \"-$2\" 2>/dev/null || true' hey-output-killer \"$grace\" \"$child_pid\" & killer_pid=$!; }; "
  + "wait_group_killer() { if [ -n \"$killer_pid\" ]; then wait \"$killer_pid\" 2>/dev/null || true; killer_pid=; fi; }; "
  + "cleanup_group() { if [ -n \"$child_pid\" ] && kill -0 -- \"-$child_pid\" 2>/dev/null; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; start_group_killer; wait_group_killer; fi; }; "
  + "terminate_child() { if [ -n \"$child_pid\" ]; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; kill -TERM \"$child_pid\" 2>/dev/null || true; start_group_killer; wait \"$child_pid\" 2>/dev/null || true; wait_group_killer; child_pid=; fi; }; "
  + "stop_child() { trap - HUP INT TERM USR1; stop_timer; terminate_child; exit 143; }; "
  + "trap 'timed_out=1' USR1; trap stop_child HUP INT TERM; "
  + "setpriv --pdeathsig KILL setsid \"$@\" "
  + "> >(head -c \"$((stdout_limit + 1))\") "
  + "2> >(head -c \"$((stderr_limit + 1))\" >&2) & child_pid=$!; "
  + "if [ \"$deadline\" -gt 0 ]; then parent_pid=$BASHPID; "
  + "setpriv --pdeathsig KILL setsid bash -c 'sleep \"$1\" || exit 0; kill -USR1 \"$2\" 2>/dev/null || exit 0; kill -TERM -- \"-$3\" 2>/dev/null || true; kill -TERM \"$3\" 2>/dev/null || true; end=$((SECONDS + $4)); while kill -0 -- \"-$3\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; if kill -0 -- \"-$3\" 2>/dev/null; then kill -KILL -- \"-$3\" 2>/dev/null || true; fi' "
  + "hey-output-timeout \"$deadline\" \"$parent_pid\" \"$child_pid\" \"$grace\" & timer_pid=$!; fi; "
  + "wait \"$child_pid\"; status=$?; "
  + "if [ \"$timed_out\" -eq 1 ]; then wait \"$child_pid\" 2>/dev/null || true; status=124; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; "
  + "else stop_timer; cleanup_group; fi; child_pid=; exit \"$status\""

function boundedCaptureCommand(command, stdoutLimit, stderrLimit, timeoutSeconds, killGraceSeconds) {
  var source = Array.isArray(command) ? command : []
  var stdoutBytes = positiveInteger(stdoutLimit, cliResponseByteLimit)
  var stderrBytes = positiveInteger(stderrLimit, cliErrorByteLimit)
  var deadline = timeoutSeconds === 0 ? 0 : positiveInteger(timeoutSeconds, finiteCommandTimeoutSec)
  var grace = positiveInteger(killGraceSeconds, finiteCommandKillGraceSec)
  return ["setpriv", "--pdeathsig", "TERM", "bash", "-o", "pipefail", "-c",
    boundedCaptureScript, "hey-output-guard", String(stdoutBytes), String(stderrBytes),
    String(deadline), String(grace)].concat(source)
}

function capturedCommandPayload(command) {
  var source = Array.isArray(command) ? command : []
  if (source.length < 13 || source[0] !== "setpriv" || source[1] !== "--pdeathsig"
      || source[2] !== "TERM" || source[3] !== "bash" || source[4] !== "-o"
      || source[5] !== "pipefail" || source[6] !== "-c"
      || source[7] !== boundedCaptureScript || source[8] !== "hey-output-guard") return source.slice()
  return source.slice(13)
}

function exceedsUtf8ByteLimit(value, limit) {
  var text = String(value || "")
  var maximum = positiveInteger(limit, cliResponseByteLimit)
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff
        && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00
        && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i += 1
    } else bytes += 3
    if (bytes > maximum) return true
  }
  return false
}

function boundedString(value, limit) {
  if (value === undefined || value === null || typeof value === "object") return ""
  var text = String(value)
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  if (text.length <= maximum) return text
  text = text.substring(0, maximum)
  var last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.substring(0, text.length - 1) : text
}

function boundedRemoteCount(value, fallback) {
  if (value === undefined || value === null || typeof value === "object") return fallback
  var text = String(value).trim()
  if (text.length === 0 || text.length > remoteCountCharacterLimit || !/^\d+$/.test(text)) return fallback
  var count = parseInt(text, 10)
  return isFinite(count) ? Math.min(remoteCountMaximum, count) : fallback
}

function parseJson(raw, byteLimit) {
  var source = String(raw || "")
  if (exceedsUtf8ByteLimit(source, byteLimit || cliResponseByteLimit)) {
    return { ok: false, error: "The HEY CLI response exceeded its size limit", code: "" }
  }
  var text = source.trim()
  if (text === "") return { ok: false, error: "The HEY CLI returned no data", code: "" }

  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "The HEY CLI returned invalid data", code: "" }
    if (parsed.ok === false) {
      return {
        ok: false,
        error: cleanText(parsed.error || parsed.message || "The HEY CLI request failed", remoteErrorCharacterLimit),
        code: boundedString(parsed.code || "", remoteCodeCharacterLimit),
        hint: cleanText(parsed.hint || "", remoteHintCharacterLimit)
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the HEY CLI response", code: "" }
  }
}

// The CLI writes its error envelope to stderr and nothing to stdout, so a
// failed command is read from whichever stream carried it. `auth` is the
// CLI's code for a signed-out state; `auth_required` is kept for older
// builds.
function parseFailure(stdout, stderr) {
  var hasStderr = String(stderr || "").trim() !== ""
  var text = hasStderr ? stderr : stdout
  var result = parseJson(text, hasStderr ? cliErrorByteLimit : cliResponseByteLimit)
  if (result.ok) return { ok: false, error: "The HEY CLI request failed", code: "", hint: "" }
  return result
}

function isAuthError(code) {
  var value = boundedString(code || "", remoteCodeCharacterLimit)
  return value === "auth" || value === "auth_required"
}

var minimumCliVersion = "0.2.2"
var cliTooOldMessage = "HEY CLI " + minimumCliVersion + " or newer is required (omarchy-mise-install github:basecamp/hey-cli hey)"

// The probe answers three questions in one process — is the CLI there, is it
// new enough, is it signed in — by printing the version line ahead of the
// auth status. `hey --version` is the one-liner (`hey version` answers the
// JSON envelope once its output is a pipe). bash always exists, so the
// process always exits; a bare `hey` would never report an exit when the
// binary is missing.
var probeCommand = boundedCaptureCommand(
  ["bash", "-c", "command -v hey >/dev/null 2>&1 || { echo missing; exit 0; }; hey --version 2>/dev/null | head -n 1; hey auth status --json"],
  probeResponseByteLimit, cliErrorByteLimit)

// parseProbe splits the probe's output into the version it read and the auth
// status behind it. No version line — a build whose `hey version` failed, or a
// test feeding the status alone — leaves the version unknown, not wrong.
function parseProbe(text) {
  var raw = String(text || "")
  if (exceedsUtf8ByteLimit(raw, probeResponseByteLimit)) return { version: "", status: "" }
  var match = raw.match(/^\s*hey version (\S+)[^\n]*\n?/)
  if (!match) return { version: "", status: raw }
  return {
    version: boundedString(match[1], remoteTypeCharacterLimit),
    status: raw.substring(match[0].length)
  }
}

// cliVersionTooOld says whether a version the probe read is older than the
// minimum. `hey watch` exists before 0.2.0 but says neither ready nor which
// threads are new, so an old watch would run and never be live; the version
// is how that is caught up front. A dev build, or a version that does not
// read as one, is not held against the CLI.
function cliVersionTooOld(version) {
  var parts = parseSemver(version)
  if (!parts) return false
  var minimum = parseSemver(minimumCliVersion)
  for (var i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] < minimum[i]
  }
  return false
}

function parseSemver(version) {
  var match = boundedString(version || "", remoteTypeCharacterLimit).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null
}

// An older CLI trips over a flag it does not have — `hey box --account` is
// 0.2.0 — or an event it does not know — `hey watch --events new` is 0.2.0
// too — and a release older still has no `hey watch` and reports an unknown
// command. HEY CLI 0.2.2 adds topic deep links for terminal clicks. The plugin only
// ever passes fixed flags, so any unknown one means the CLI is too old.
function cliTooOld(stdout, stderr) {
  var errorText = boundedString(stderr || "", remoteErrorCharacterLimit)
  var outputText = boundedString(stdout || "", remoteErrorCharacterLimit)
  return /unknown (command|flag|event)/i.test(errorText + outputText)
}

// hey box imbox is the read: the panel's thread limit, and --account all once
// the CLI has shown it knows accounts, so a persisted default account
// selection cannot hide mail from the panel.
function boxCommand(limit, withAccountFilter) {
  var command = ["hey", "box", "imbox", "--limit", String(Math.min(maximumPostingCount, positiveInteger(limit, maximumPostingCount))), "--json"]
  if (withAccountFilter) command.splice(3, 0, "--account", "all")
  return boundedCaptureCommand(command, cliResponseByteLimit, cliErrorByteLimit)
}

// hey watch is the wake-up: it follows every box over HEY's cable and prints
// a line per change, plus "ready", "disconnected" and "resync" about itself.
// setpriv --pdeathsig ties it to the shell, so a shell that dies takes its
// watch along instead of leaving one behind per restart. It watches every box
// — a move out of the Imbox is written in the box the thread went to — across
// every account, so a persisted default account selection cannot hide changes
// from the panel, and it asks for every event by name: `new` so each added
// and updated line says whether the thread is new mail, `resync` so a box
// that skipped ahead is re-read. A CLI that does not know `new` refuses the
// command up front instead of running a watch that never says it.
function watchCommand() {
  return boundedCaptureCommand(
    ["setpriv", "--pdeathsig", "TERM", "hey", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"],
    watchOutputByteLimit, cliErrorByteLimit, 0)
}

// watchLine reads one line from hey watch: its change — added, updated or
// deleted for a thread; ready, disconnected or resync about the watch — and,
// for a thread, whether the CLI called it new mail, the box it is in and the
// posting itself. Blank, malformed and oversized lines are discarded.
function watchLine(line) {
  var source = String(line || "")
  if (exceedsUtf8ByteLimit(source, watchLineByteLimit)) return null
  var text = source.trim()
  if (text === "") return null
  try {
    var value = JSON.parse(text)
    if (!value || typeof value.change !== "string") return null
    var event = { change: "", isNew: false, boxKind: "", boxName: "", posting: null }
    event.change = boundedString(value.change, remoteTypeCharacterLimit)
    event.isNew = value["new"] === true
    if (value.box && typeof value.box === "object") {
      event.boxKind = boundedString(value.box.kind || "", remoteTypeCharacterLimit)
      event.boxName = cleanText(value.box.name || "", remoteNameCharacterLimit)
    }
    if (value.posting && typeof value.posting === "object") event.posting = boundedWatchPosting(value.posting)
    return event
  } catch (error) {
    return null
  }
}

function boundedWatchPosting(value) {
  var posting = value && typeof value === "object" ? value : {}
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  return {
    id: boundedString(posting.id || "", remoteIdCharacterLimit),
    name: cleanText(posting.name || "", remoteTitleCharacterLimit),
    summary: cleanText(posting.summary || "", remoteExcerptCharacterLimit),
    app_url: boundedString(posting.app_url || "", remoteUrlCharacterLimit),
    url: boundedString(posting.url || "", remoteUrlCharacterLimit),
    account_id: boundedString(posting.account_id || "", remoteIdCharacterLimit),
    alternative_sender_name: cleanText(posting.alternative_sender_name || "", remoteNameCharacterLimit),
    creator: {
      name: cleanText(creator.name || "", remoteNameCharacterLimit),
      email_address: cleanText(creator.email_address || "", remoteNameCharacterLimit)
    }
  }
}

// The toast. What counts as new is the CLI's call, made on every line; what
// to do about it is the plugin's: the Imbox only, since HEY's attention model
// puts new mail in one place, one toast per burst, replaced rather than
// stacked, under the app-name HEY so Omarchy's notification silencing applies
// (its own `omarchy-action` pops through DND on purpose), with the HEY app icon
// and a click that opens the configured HEY destination. The exec runs on the
// shell's side, so it survives shell restarts.
var toastAppName = "HEY"
var toastIcon = "hey"
var toastPreviewLimit = 96
var toastFocusCommand = "omarchy-launch-or-focus-tui --app-id=org.omarchy.hey hey tui --instance omarchy"
var heyWebUrl = "https://app.hey.com"

function topicIdFromUrl(value) {
  var match = boundedString(value, remoteUrlCharacterLimit).match(/\/topics\/(\d+)(?:[/?#]|$)/)
  if (!match) return 0
  var id = parseInt(match[1], 10)
  return isFinite(id) && id > 0 ? id : 0
}

function positiveId(value) {
  var id = parseInt(boundedString(value, remoteIdCharacterLimit), 10)
  return isFinite(id) && id > 0 ? id : 0
}

function tuiRemoteCommand(topicId, accountId, title) {
  var topic = positiveId(topicId)
  if (topic === 0) return []
  var command = ["hey"]
  var account = positiveId(accountId)
  if (account > 0) command.push("--account", String(account))
  command.push("tui", "--instance", "omarchy", "--topic", String(topic))
  var topicTitle = cleanText(title, remoteTitleCharacterLimit)
  if (topicTitle !== "") command.push("--topic-title", topicTitle)
  command.push("--remote")
  return command
}

function tuiFocusCommand(topicId, accountId, title) {
  var command = ["omarchy-launch-or-focus-tui", "--app-id=org.omarchy.hey", "hey"]
  var account = positiveId(accountId)
  if (account > 0) command.push("--account", String(account))
  command.push("tui", "--instance", "omarchy")
  var topic = positiveId(topicId)
  if (topic > 0) command.push("--topic", String(topic))
  return command
}

function shellCommand(command) {
  var parts = []
  for (var i = 0; i < command.length; i++) parts.push(shellQuote(command[i]))
  return parts.join(" ")
}

function tuiOpenCommand(topicId, accountId, title) {
  var remote = tuiRemoteCommand(topicId, accountId, title)
  var focus = tuiFocusCommand(topicId, accountId, title)
  if (remote.length === 0 && positiveId(accountId) === 0) return toastFocusCommand
  if (remote.length === 0) return shellCommand(focus)
  return shellCommand(remote) + " >/dev/null 2>&1 || true; " + shellCommand(focus)
}

// HEY posting URLs can be absolute or app-relative. Web actions stay on the
// canonical HEY origin, with HEY's home page as the safe destination.
function heyBrowserUrl(value) {
  var url = boundedString(value, remoteUrlCharacterLimit).trim()
  if (/^https:\/\/app\.hey\.com(?:[/?#]|$)/i.test(url)) return url
  if (url.charAt(0) === "/") return heyWebUrl + url
  return heyWebUrl
}

// The toast action follows the configured destination. Web destinations open
// the message URL, and grouped mail opens HEY's default page.
function toastExecCommand(clickAction, targetUrl, topicId, accountId, title) {
  var action = String(clickAction || "")
  var url = shellQuote(heyBrowserUrl(targetUrl))
  if (action === "app") return "omarchy-launch-webapp " + url
  if (action === "browser") return "xdg-open " + url
  return tuiOpenCommand(topicId, accountId, title)
}

// Notification ids are daemon-local, not stable identities: after a shell
// restart the same number may belong to another application's notification,
// and -r would overwrite that instead of replacing ours. Replacement only
// matters for back-to-back bursts, so a short window loses nothing.
var toastReplaceWindowMs = 10 * 60 * 1000

function newImboxMail(event) {
  return !!event && event.isNew === true && event.boxKind === "imbox" && event.posting !== null
}

function postingSender(posting) {
  var creator = posting && posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  return cleanText(posting.alternative_sender_name || creator.name || creator.email_address || "", remoteNameCharacterLimit)
}

function postingSubject(posting) {
  return cleanText(posting.name || posting.summary || "", remoteTitleCharacterLimit)
}

// notificationPreview provides one concise body line. HTML breaks and escaped
// newlines establish the first line, and long previews end with an ellipsis.
function notificationPreview(value, limit) {
  var lines = boundedString(value, remoteExcerptCharacterLimit)
    .replace(/\\[nr]/g, "\n")
    .replace(/<br\s*\/?\s*>|<\/p\s*>/gi, "\n")
    .split(/\r?\n/)
  var preview = ""
  for (var i = 0; i < lines.length; i++) {
    preview = cleanText(lines[i])
    if (preview !== "") break
  }
  var maximum = positiveInteger(limit, toastPreviewLimit)
  if (preview.length <= maximum) return preview
  return preview.substring(0, maximum - 1).trim() + "…"
}

// composeMailToast gives each popup three content lines: HEY, the subject, and
// the first concise line of the message. A burst uses its count as the subject
// and the first senders as its description.
function composeMailToast(boxName, postings) {
  var fresh = Array.isArray(postings) ? postings.slice(0, maximumToastPostings) : []
  if (fresh.length === 1) {
    var posting = fresh[0]
    var subject = postingSubject(posting)
    var description = notificationPreview(posting.summary || "")
    if (description === subject) description = ""  // the summary already stood in for a missing subject
    return {
      headline: toastAppName + "\n" + subject,
      description: description,
      targetUrl: heyBrowserUrl(posting.app_url || posting.url),
      topicId: topicIdFromUrl(posting.app_url || posting.url),
      accountId: positiveId(posting.account_id),
      title: subject
    }
  }

  var senders = []
  for (var i = 0; i < fresh.length; i++) {
    if (senders.length === 3) {
      senders.push("…")
      break
    }
    senders.push(postingSender(fresh[i]))
  }
  return {
    headline: toastAppName + "\n" + fresh.length + " new in " + (cleanText(boxName, remoteNameCharacterLimit) || "Imbox"),
    description: notificationPreview(senders.join(", ")),
    targetUrl: heyWebUrl,
    topicId: 0,
    accountId: 0,
    title: ""
  }
}

// notificationText keeps mail-derived text from being read as an option:
// notify-send parses a leading dash wherever it appears, and a subject or
// summary can start with one. A word joiner is invisible on screen but makes
// the argument a plain positional.
function notificationText(text) {
  var value = boundedString(text, remoteExcerptCharacterLimit)
  return value.charAt(0) === "-" ? "\u2060" + value : value
}

// replaceableToastId is the last toast's id while it is recent enough to
// trust, and 0 otherwise.
function replaceableToastId(id, atMs, nowMs) {
  var value = Number(id || 0)
  if (!isFinite(value) || value <= 0) return 0
  return Number(nowMs) - Number(atMs || 0) > toastReplaceWindowMs ? 0 : value
}

// toastCommand is the argv: omarchy-notification-send takes its own options
// first, then the headline and the description, then anything for
// notify-send — -p to print the daemon's id, -r to replace the last one.
function toastCommand(headline, description, replaceId, clickAction, targetUrl, topicId, accountId, title) {
  var command = [
    "omarchy-notification-send",
    "--app-name", toastAppName,
    "-u", "low",
    "--exec", toastExecCommand(clickAction, targetUrl, topicId, accountId, title),
    notificationText(headline)
  ]
  if (String(description || "") !== "") command.push(notificationText(description))
  command.push("-i", toastIcon, "-p")
  var id = Number(replaceId || 0)
  if (isFinite(id) && id > 0) command.push("-r", String(id))
  return command
}

// `hey screener list --count --json` answers a bare number since the global
// --count took over from the command's own flag; older CLIs answer the envelope
// with `data.pending_count`. Both are a count.
function parseScreenerCount(raw) {
  var source = String(raw || "")
  if (exceedsUtf8ByteLimit(source, cliResponseByteLimit)) return { ok: false, error: "The HEY CLI response exceeded its size limit", count: 0 }
  var text = source.trim()
  if (/^\d+$/.test(text)) {
    var bareCount = boundedRemoteCount(text, -1)
    return bareCount < 0
      ? { ok: false, error: "Could not parse the HEY Screener count", count: 0 }
      : { ok: true, count: bareCount }
  }
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, count: 0 }
  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var count = boundedRemoteCount(data.pending_count, -1)
  if (count < 0) return { ok: false, error: "Could not parse the HEY Screener count", count: 0 }
  return { ok: true, error: "", count: count }
}

function parseAccounts(raw) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, accounts: [] }

  var data = Array.isArray(result.value.data) ? result.value.data : []
  var accounts = []
  var inputCount = Math.min(data.length, maximumAccountCount + 1)
  for (var i = 0; i < inputCount && accounts.length < maximumAccountCount; i++) {
    var account = data[i] || {}
    var id = boundedString(account.id || "", remoteIdCharacterLimit).trim()
    // The CLI includes an "all" pseudo-account for its filter list.
    if (id === "" || id === "all") continue
    accounts.push({
      id: id,
      name: cleanText(account.name || ("Account " + id), remoteNameCharacterLimit),
      order: accounts.length
    })
  }

  return { ok: true, error: "", accounts: accounts }
}

function parseNotifications(raw, limit, accounts) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, items: [] }

  var accountsById = {}
  var source = Array.isArray(accounts) ? accounts : []
  var accountCount = Math.min(source.length, maximumAccountCount)
  for (var a = 0; a < accountCount; a++) {
    var sourceId = boundedString(source[a].id || "", remoteIdCharacterLimit)
    accountsById[sourceId] = source[a]
  }

  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var postings = Array.isArray(data.postings) ? data.postings : []
  var items = []
  var count = Math.min(maximumPostingCount, positiveInteger(limit, maximumPostingCount))
  var postingCount = Math.min(postings.length, maximumPostingCount)
  for (var i = 0; i < postingCount; i++) {
    var item = normalizeNotification(postings[i], accountsById)
    if (item) items.push(item)
  }

  items.sort(compareNotifications)
  if (items.length > count) items = items.slice(0, count)
  return { ok: true, error: "", items: items }
}

function normalizeNotification(value, accountsById) {
  var posting = value && typeof value === "object" ? value : {}
  var id = boundedString(posting.id || "", remoteIdCharacterLimit).trim()
  if (id === "") return null

  var timestamp = boundedString(posting.active_at || posting.updated_at || posting.created_at || "", remoteTimestampCharacterLimit)
  var parsedTime = Date.parse(timestamp)
  if (!isFinite(parsedTime)) parsedTime = 0
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  var creatorName = cleanText(creator.name || posting.alternative_sender_name || "", remoteNameCharacterLimit)
  var accountId = boundedString(posting.account_id || "", remoteIdCharacterLimit)
  var account = (accountsById && accountsById[accountId]) || {}

  return {
    id: id,
    accountId: accountId,
    accountName: cleanText(account.name || "", remoteNameCharacterLimit),
    accountOrder: Number(account.order || 0),
    title: cleanText(posting.name || "HEY email", remoteTitleCharacterLimit),
    excerpt: cleanText(posting.summary || posting.note || "", remoteExcerptCharacterLimit),
    project: "",
    creator: creatorName,
    initials: cleanText(creator.initials || "", remoteTypeCharacterLimit) || computeInitials(creatorName),
    type: cleanText(posting.entry_kind || posting.kind || "email", remoteTypeCharacterLimit),
    timestamp: timestamp,
    timestampMs: parsedTime,
    url: boundedString(posting.app_url || "", remoteUrlCharacterLimit),
    unread: posting.seen !== true,
    unreadCount: boundedRemoteCount(posting.visible_entry_count, 1)
  }
}

function computeInitials(name) {
  var words = cleanText(name, remoteNameCharacterLimit).split(" ")
  var initials = ""
  for (var i = 0; i < words.length && initials.length < 2; i++) {
    var letter = words[i].charAt(0)
    if (/[0-9A-Za-z]/.test(letter)) initials += letter.toUpperCase()
  }
  return initials === "" ? "?" : initials
}

function compareNotifications(a, b) {
  if (a.unread !== b.unread) return a.unread ? -1 : 1
  var timeDifference = Number(b.timestampMs || 0) - Number(a.timestampMs || 0)
  if (timeDifference !== 0) return timeDifference
  var accountDifference = Number(a.accountOrder || 0) - Number(b.accountOrder || 0)
  if (accountDifference !== 0) return accountDifference
  return boundedString(a.id || "", remoteIdCharacterLimit).localeCompare(
    boundedString(b.id || "", remoteIdCharacterLimit))
}

function sortNotifications(items) {
  var sorted = Array.isArray(items) ? items.slice(0, maximumPostingCount) : []
  sorted.sort(compareNotifications)
  return sorted
}

function filterNotifications(items, accountId, state) {
  var source = Array.isArray(items) ? items.slice(0, maximumPostingCount) : []
  var selectedAccount = boundedString(accountId || "", remoteIdCharacterLimit)
  var selectedState = boundedString(state || "all", remoteTypeCharacterLimit)
  return source.filter(function(item) {
    if (selectedAccount !== ""
        && boundedString(item.accountId || "", remoteIdCharacterLimit) !== selectedAccount) return false
    if (selectedState === "unread") return item.unread === true
    if (selectedState === "previous") return item.unread !== true
    return true
  })
}

function accountFilterOptions(accounts) {
  var options = [{ value: "", label: "All accounts" }]
  var source = Array.isArray(accounts) ? accounts.slice(0, maximumAccountCount) : []
  source.sort(function(a, b) {
    return cleanText(a.name || "HEY", remoteNameCharacterLimit).toLowerCase().localeCompare(
      cleanText(b.name || "HEY", remoteNameCharacterLimit).toLowerCase())
  })
  for (var i = 0; i < source.length; i++) {
    options.push({
      value: boundedString(source[i].id || "", remoteIdCharacterLimit),
      label: cleanText(source[i].name || "HEY", remoteNameCharacterLimit)
    })
  }
  return options
}

// Chromatic ANSI slots only: black/white and the greys make unreadable
// avatar fills, so they never join the palette. Omarchy themes write
// colors.toml in one of two schemas — numbered terminal slots (color1..14)
// or named colors (red, bright_blue, ...) — so both key styles are listed.
var AVATAR_COLOR_KEYS = [
  "color1", "color2", "color3", "color4", "color5", "color6",
  "color9", "color10", "color11", "color12", "color13", "color14",
  "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown",
  "bright_red", "bright_yellow", "bright_green",
  "bright_cyan", "bright_blue", "bright_magenta"
]

function themeAvatarPalette(raw) {
  var byKey = {}
  var lines = boundedString(raw, cliErrorByteLimit).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) byKey[match[1]] = match[2]
  }

  var palette = []
  var seen = {}
  for (var k = 0; k < AVATAR_COLOR_KEYS.length; k++) {
    var hex = byKey[AVATAR_COLOR_KEYS[k]]
    if (!hex) continue
    var lower = hex.toLowerCase()
    if (seen[lower]) continue
    seen[lower] = true
    palette.push(hex)
  }
  return palette
}

function nameHash(text) {
  var value = boundedString(text, remoteNameCharacterLimit)
  var hash = 5381
  for (var i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  return hash
}

// Same idea as haystack's avatar_background_color: a stable hash of the
// sender picks the color, so one sender always gets the same fill.
function avatarColorIndex(name, count) {
  var total = Number(count || 0)
  if (!isFinite(total) || total <= 0) return 0
  return nameHash(cleanText(name, remoteNameCharacterLimit)) % total
}

function notificationBadgeText(item, hovered) {
  if (hovered) return "󰅖"  // md-close
  return String(Math.max(1, (item && item.unreadCount) || 0))
}

function decodeTextEntity(entity) {
  switch (String(entity || "").toLowerCase()) {
    case "&nbsp;": return " "
    case "&amp;": return "&"
    case "&lt;": return "<"
    case "&gt;": return ">"
    case "&#39;":
    case "&apos;": return "'"
    case "&quot;": return "\""
    default: return ""
  }
}

function cleanText(value, limit) {
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  var text = boundedString(value, maximum)
    .replace(/\\[nrt]/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|#39|apos|quot);/gi, decodeTextEntity)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return boundedString(text, maximum)
}

function positiveInteger(value, fallback) {
  var parsed = parseInt(String(value || ""), 10)
  return isFinite(parsed) && parsed > 0 ? parsed : fallback
}

var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function notificationTime(timestampMs, nowMs) {
  var value = Number(timestampMs || 0)
  if (!isFinite(value) || value <= 0) return ""
  var now = nowMs === undefined ? Date.now() : Number(nowMs)
  var date = new Date(value)
  var ref = new Date(now)
  if (date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate()) {
    var hours = date.getHours()
    var hour12 = hours % 12 === 0 ? 12 : hours % 12
    var minutes = date.getMinutes()
    return hour12 + ":" + (minutes < 10 ? "0" + minutes : minutes) + (hours >= 12 ? "pm" : "am")
  }
  var label = MONTH_NAMES[date.getMonth()] + " " + date.getDate()
  if (date.getFullYear() !== ref.getFullYear()) label += ", " + date.getFullYear()
  return label
}

function notificationMeta(item, nowMs, showAccount) {
  if (!item) return ""
  var parts = []
  var age = notificationTime(item.timestampMs, nowMs)
  var creator = cleanText(item.creator || "", remoteNameCharacterLimit)
  var account = cleanText(item.accountName || "", remoteNameCharacterLimit)
  if (age !== "") parts.push(age)
  if (creator !== "") parts.push(creator)
  if (showAccount === true && account !== "") parts.push(account)
  return parts.join(" • ")
}

if (typeof module !== "undefined") {
  module.exports = {
    setupLockCheckCommand: setupLockCheckCommand,
    setupLaunchCommand: setupLaunchCommand,
    setupPlan: setupPlan,
    boundedCaptureCommand: boundedCaptureCommand,
    capturedCommandPayload: capturedCommandPayload,
    exceedsUtf8ByteLimit: exceedsUtf8ByteLimit,
    boundedString: boundedString,
    boundedRemoteCount: boundedRemoteCount,
    cliResponseByteLimit: cliResponseByteLimit,
    cliErrorByteLimit: cliErrorByteLimit,
    probeResponseByteLimit: probeResponseByteLimit,
    finiteCommandTimeoutSec: finiteCommandTimeoutSec,
    finiteCommandKillGraceSec: finiteCommandKillGraceSec,
    watchOutputByteLimit: watchOutputByteLimit,
    watchLineByteLimit: watchLineByteLimit,
    maximumAccountCount: maximumAccountCount,
    maximumPostingCount: maximumPostingCount,
    maximumToastPostings: maximumToastPostings,
    remoteIdCharacterLimit: remoteIdCharacterLimit,
    remoteNameCharacterLimit: remoteNameCharacterLimit,
    remoteTitleCharacterLimit: remoteTitleCharacterLimit,
    remoteExcerptCharacterLimit: remoteExcerptCharacterLimit,
    remoteUrlCharacterLimit: remoteUrlCharacterLimit,
    remoteTimestampCharacterLimit: remoteTimestampCharacterLimit,
    remoteTypeCharacterLimit: remoteTypeCharacterLimit,
    remoteCountCharacterLimit: remoteCountCharacterLimit,
    remoteCountMaximum: remoteCountMaximum,
    remoteErrorCharacterLimit: remoteErrorCharacterLimit,
    remoteHintCharacterLimit: remoteHintCharacterLimit,
    remoteCodeCharacterLimit: remoteCodeCharacterLimit,
    parseJson: parseJson,
    parseFailure: parseFailure,
    isAuthError: isAuthError,
    cliTooOld: cliTooOld,
    cliTooOldMessage: cliTooOldMessage,
    probeCommand: probeCommand,
    parseProbe: parseProbe,
    cliVersionTooOld: cliVersionTooOld,
    boxCommand: boxCommand,
    watchCommand: watchCommand,
    watchLine: watchLine,
    newImboxMail: newImboxMail,
    composeMailToast: composeMailToast,
    notificationPreview: notificationPreview,
    notificationText: notificationText,
    replaceableToastId: replaceableToastId,
    toastCommand: toastCommand,
    toastExecCommand: toastExecCommand,
    topicIdFromUrl: topicIdFromUrl,
    tuiRemoteCommand: tuiRemoteCommand,
    tuiFocusCommand: tuiFocusCommand,
    tuiOpenCommand: tuiOpenCommand,
    heyBrowserUrl: heyBrowserUrl,
    toastAppName: toastAppName,
    toastIcon: toastIcon,
    toastPreviewLimit: toastPreviewLimit,
    toastFocusCommand: toastFocusCommand,
    heyWebUrl: heyWebUrl,
    toastReplaceWindowMs: toastReplaceWindowMs,
    parseScreenerCount: parseScreenerCount,
    parseAccounts: parseAccounts,
    parseNotifications: parseNotifications,
    sortNotifications: sortNotifications,
    filterNotifications: filterNotifications,
    accountFilterOptions: accountFilterOptions,
    notificationBadgeText: notificationBadgeText,
    computeInitials: computeInitials,
    themeAvatarPalette: themeAvatarPalette,
    avatarColorIndex: avatarColorIndex,
    cleanText: cleanText,
    notificationTime: notificationTime,
    notificationMeta: notificationMeta
  }
}
