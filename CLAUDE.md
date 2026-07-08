# HR Logtime MCP Server — Claude Instructions

## Architecture

This is a **local MCP server** (`mcp-server.js`, stdio transport), same
pattern as PM Assistant's `src/index.js` — it runs on the HR user's own
machine, registered in their local Claude Code, so Jira/Slack/Tempo/Google
API calls go out over that machine's real network. This was a deliberate
pivot from an earlier design (a Claude Code "Skill" with plain CLI
scripts invoked via `Bash`): that design broke inside sandboxed agent
environments (e.g. Cowork) whose network egress proxy blocks arbitrary
outbound domains (Jira, Slack, Tempo, Google were all blocked — only a
handful of domains like the npm registry were allowed). Running as a
local MCP server on the HR's own machine sidesteps that entirely, since
the network calls never touch the sandboxed environment.

Seven MCP tools, each a thin dispatcher over `scripts/*.js` (which are
plain importable functions — no `process.exit`, no argv parsing, no
`console.log`; every outcome is a returned string, because exiting the
process would kill every other in-flight tool call on this same server):

1. **`hr_menu`** — no-arg tool that returns a numbered task list with
   example phrasing, same idea as PM Assistant's `pm_menu`. Call this when
   the user asks what this server can do, or asks for a menu/overview.
   Config-related actions are NOT individual menu items — they're all
   under a single "Config" entry that points at `hr_config`.
2. **`hr_config`** — no-arg tool that reports every configurable value
   (personal ticket, default comment, report template, report folder)
   with its current value or "chưa cấu hình". This is a **status report,
   not a wizard** — it doesn't ask anything itself. See "Config flow"
   below for the actual multi-turn behavior Claude must drive.
3. **`logtime`** — one HR user checking/logging time against their own
   Jira ticket. Logic is a direct port of PM Assistant's `log_time.js`
   (same Slack-absence detection, same HAE/MISC holiday handling, same
   preview-before-write flow).
4. **`export_report`** — copies a master template into a Drive folder
   once per month (named `Timesheet <Mon> <Year>`, skipped if it already
   exists) and writes real Jira/Tempo data into its `Jira log` / `Jira
   absence` / `Jira OT` tabs. Re-running for a month that already has a
   file updates those three tabs in place. It also updates the Month (F1)
   / Year (H1) cells on the `Timesheet ` (trailing space — real tab name),
   `OT`, and `MISC` tabs, since those drive a cascading date row (E5
   onward) and every VLOOKUP that reads from the three tabs above —
   without this, those tabs would keep showing whatever month the
   template last had. It also writes each employee's total WFH hours for
   the target month into the `WFH` tab's matching month column, sourced
   from the `wfh-request` Slack channel (see below — this one tab is NOT
   derivable from Jira/Tempo at all). No employee roster to maintain for
   the Jira-derived tabs — everyone is discovered straight from that
   month's actual Tempo worklogs. Also has `action="notify"`, offered
   right after a successful `run`: announces the timesheet is ready on
   Slack, same preview → edit → confirm discipline as everything else.
5. **`update_absence`** — explicit, on-demand refresh of one day's
   absence cache + a readout of who declared đi muộn/về sớm/nghỉ that
   day. Not a gate other tools depend on — `logtime`/`missing_logtime`
   still auto-refresh the cache themselves when stale; this is just the
   named, proactive way to warm it and see today's activity without
   running a heavier check. See "`update_absence` discipline" below.
6. **`set_hae_misc`** — monthly setup: creates (or reuses) the HAE
   "Holidays & Events" ticket and this month's MISC "Absence" ticket,
   wires their keys into `absence_cache.json` for `logtime` to use, then
   announces both on Slack. Same preview → edit → confirm discipline as
   everything else here — see "`set_hae_misc` discipline" below.
7. **`missing_logtime`** — scans the company for who's missing logtime in
   a date range and posts a reminder to the absence Slack channel, gated
   by the same scan → preview → confirm discipline as PM Assistant's
   `po_plan`/`sprint_report`/`overtime_log` tools.

Full argument shapes are in each tool's `inputSchema` in `mcp-server.js` —
that's what Claude actually sees via the MCP protocol regardless of
working directory, so keep those descriptions accurate; this file is
supplementary depth for when working inside the project folder itself.

## Required credentials (`.env`, gitignored)

`JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `SLACK_USER_TOKEN` — needed
by every tool that touches Jira/Slack identity or absence detection:
`logtime`, `update_absence`, `set_hae_misc`, `export_report`, and
`missing_logtime`. `export_report` additionally needs `TEMPO_API_TOKEN`
and Google OAuth (`GOOGLE_OAUTH_*`); `missing_logtime` also needs
`TEMPO_API_TOKEN`.

*Tempo:* this company's Jira worklogs are synced through the Tempo
Timesheets app, and every Tempo-synced worklog's Jira `author` field is the
Tempo integration bot, not the real employee — confirmed by direct API
inspection (querying `worklogAuthor = <employee>` matches none of their
Tempo-logged issues; `worklogAuthor = <Tempo bot account>` matches all of
them). The real author only exists in Tempo's own API
(`https://api.tempo.io/4/worklogs`, wrapped by `scripts/lib/tempo.js`).
Generate a token in Jira under **Apps → Tempo → Settings → API
Integration** and set it as `TEMPO_API_TOKEN`. Without it, `export_report`
fails loudly rather than silently using incomplete data.

*Google auth:* the Drive MCP tools Claude has via claude.ai connectors
(`copy_file`, `create_file`, `read_file_content`, ...) can create/copy
whole files but cannot write into a specific tab of an *existing*
spreadsheet — there is no "update this range" tool in that surface.
Populating `Jira log`/`Jira absence`/`Jira OT` on a file that already
exists needs the real Sheets API (`spreadsheets.values.update`), which
needs its own credentials. `scripts/lib/gsheets.js` authenticates via
**User OAuth** (`GOOGLE_OAUTH_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`,
refreshed with Node's built-in `fetch` — no external dependency) — it acts
as a real Workspace account that already has access, so no file/folder
sharing is needed at all.

This is a deliberate choice, not the only possible approach: a
service-account JWT method was tried first and rejected by this org's
Workspace policy ("Policy set by the administrators ... prohibits the
sharing of items with `...iam.gserviceaccount.com`, because it is not a
Google Account in a compatible allowlisted domain") — sharing a file with a
service account's `client_email` is exactly the kind of "foreign identity"
that policy blocks. User OAuth sidesteps it entirely since nothing needs to
be shared. Don't reintroduce the service-account path unless the org's
policy changes.

Setup: create an OAuth Client ID of type "Desktop app" in a GCP project
(only needs GCP project access, not Workspace Super Admin), set
`GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` in `.env`, then run
`node scripts/google_login.js` once — it opens a local callback server,
prints a consent URL to open in a browser, and saves the resulting
`GOOGLE_OAUTH_REFRESH_TOKEN` back into `.env` automatically. This is the
one piece that stays a standalone CLI script rather than an MCP tool — an
interactive browser-consent flow doesn't fit the request/response MCP
tool-call pattern.

Before doing a real (write) run, verify access with `files.get` on both the
template ID and folder ID (not a `files.list` search — Drive silently
returns an empty list rather than an error when you lack access to a
parent, which reads as false-positive success).

## Config flow (`hr_config` + `hr_menu`'s "Config" entry)

There is no dedicated "list config sections" *conversation* built into
`hr_config` — it only returns the current status as a text report.
**Claude drives the actual wizard**, and must do it one section at a time,
never all at once:

1. Call `hr_config()`. It returns 4 sections in order: personal ticket,
   default comment, report template, report folder — each with its
   current value or "chưa cấu hình".
2. For section 1: state its current value (or that it's unset), ask "bạn
   có muốn đổi không?", and **wait for the answer** before doing anything
   else.
   - If yes: ask for the new value, call the setter tool named in
     `hr_config`'s output for that section (`logtime(action="setup", ...)`
     for the first two, `export_report(action="configure", ...)` for the
     last two), confirm it saved, then move to section 2.
   - If no: move to section 2 immediately, no further questions about
     section 1.
3. Repeat for sections 2–4. Stop after section 4 — don't loop back to the
   start.

**Why this had to be fixed once already:** both setter functions used to
require re-supplying every field on every call, which meant "just change
the comment" silently reset the ticket back to empty (and vice versa for
template/folder). Both `runSetup` (logtime.js) and `exportReportConfigure`
(export_report.js) now do a partial update — only the fields actually
passed in change, everything else keeps its prior value, loaded fresh from
config each call. Don't reintroduce a "must pass all fields" requirement;
it breaks the one-section-at-a-time flow above.

**Any tool that detects missing required config** (`logtime` needs
`hr.autoLogIssue`; `export_report` needs both `templateFileId` and
`driveFolderId`) returns an error telling Claude to call `hr_config`
first — treat that as a hard stop: run the config flow above before
retrying the original request, don't ask for the missing value inline
outside of that flow.

## `logtime` discipline

**Normal usage — mirror the same discipline as PM Assistant's `log_time`
tool:**

1. `logtime(action="check")` — shows what's logged vs. expected. Never
   writes anything. When HR asks to "check time log" without naming a
   date range, always offer the 4 presets from `hr_menu`'s "Check my time
   log" task — Tuần này / Tuần trước / Tháng này / Tháng trước — and pass the pick as
   `period` (`thisWeek`/`lastWeek`/`thisMonth`/`lastMonth`), not hand-typed
   `from`/`to`. The tool computes the exact boundaries itself
   (`resolvePeriod` in `logtime.js`) so week/month rollovers across
   month or year boundaries are never miscounted by hand.
2. If there are wrong/missing days, show the user the plan and ask for
   confirmation.
3. Only after explicit confirmation ("ok", "có", "gửi đi", "yes" or
   equivalent — a correction or question is NOT confirmation), call
   `logtime(action="add", dates=[...])` **without** `confirm` — this
   returns a preview. Show that preview to the user verbatim.
4. Only after they confirm the preview, call the same again with
   `confirm=true` to actually write to Jira.
5. `delete` follows the identical preview → confirm pattern.

Never call any Slack MCP tool from this flow — Slack is only read
(`getChannelHistory`) inside `logtime.js` for absence detection; there is
no Slack notification here.

**HAE/MISC ticket key resolution, in priority order** (`getMonthAbsenceData`
in `logtime.js`): (1) `config.json`'s `hr.haeIssue` / `hr.miscIssueByMonth.
<month>` — set by `set_hae_misc.js`, authoritative once present, cannot be
overridden by a stray Slack mention; (2) if config lacks a value for that
scope, fall back to regex-scanning the absence channel's messages for
`HAE-\d+`/`MISC-\d+` (the original mechanism, still needed for months from
before `set_hae_misc` existed); (3) whatever was last cached in
`absence_cache.json`. Config is re-checked even on a cache hit, so running
`set_hae_misc` after `logtime` already cached a month's data still takes
effect immediately — don't reintroduce a version of this that only reads
config on a cache miss.

## `update_absence` discipline

`hr_menu`'s "Update absence information" task. Calls the exact same `getMonthAbsenceData` (in
`lib/absence_cache.js`) that `logtime`/`missing_logtime` call internally
— there's no separate cache-writing path for this tool, it's the same
one function, just invoked explicitly and on a single day instead of
implicitly as a side effect of some other check. Default `date` is
today; pass an explicit `date` (YYYY-MM-DD) to check a different day
without waiting for that month's daily refresh window. `force=true`
bypasses the "already fetched today" shortcut and re-scans `#vn-absence`
immediately — use when HR knows a relevant message just landed and
doesn't want to wait.

**This is not a required precondition for `logtime` or `missing_logtime`
— don't gate those tools on it.** They keep auto-refreshing the cache
themselves when it's stale, exactly as before; running `update_absence`
first only saves them from doing that refresh inline (and lets HR see
today's raw đi muộn/về sớm/nghỉ messages without running a full check).

## `set_hae_misc` discipline

Monthly setup: creates the HAE "Holidays & Events" ticket and this
month's MISC "Absence" ticket (real, visible Jira artifacts), saves their
keys into `config.json` (`hr.haeIssue`, `hr.miscIssueByMonth.<YYYY-MM>`)
and `absence_cache.json` for `logtime` to use, then announces both on
Slack.

1. **Always ask which month first** — "tạo cho tháng này hay tháng sau?"
   — then call `action="plan"` with `period="thisMonth"` or
   `period="nextMonth"` (not a hand-typed `month`; letting the tool
   compute the YYYY-MM avoids a hand-computed December→January bug).
   Calling `plan` with neither makes the tool ask this same question back
   — that's the intended guard, not a bug, so don't paper over it by
   guessing a month yourself.
2. The tool checks `config.json` for that month **before** touching Jira
   at all: if both `haeIssue` and `miscIssueByMonth.<month>` are already
   set, it reports them immediately and refuses to create anything —
   relay that to HR and move straight to `action="notify"`, no
   preview/confirm needed for creation in that case.
3. Otherwise `action="plan"` (no `confirm`) previews both intended
   titles and whether each will be created new, adopted from a
   pre-existing Jira ticket with the exact same title (the config-check
   in step 2 only catches tickets *this tool* already recorded — this
   catches ones that existed before, like HAE-17/MISC-51), or reused from
   config. HAE's title never changes month to month, so once set it's
   always reused, never recreated. Let HR edit via `haeTitle`/`miscTitle`
   as many times as needed.
4. Only after explicit confirmation, call `action="plan" confirm=true` —
   this is the one call that actually creates Jira tickets. Never combine
   an edited title with `confirm=true` in the same call — edit, show the
   new preview, then confirm as a separate step.
5. `action="notify"` (no `confirm`) — shows the **full** Slack
   announcement text (month name comes from whichever month was just
   planned, not necessarily the calendar's current month). Same edit
   loop via `message=`. Only `action="notify" confirm=true` actually
   posts to `#vn-absence`. Never use a Slack MCP tool for this.

Note: creating a MISC issue requires Jira "Create Issues" permission on
the MISC project for whichever account's `JIRA_EMAIL`/`JIRA_API_TOKEN`
is configured — if that's missing, `action="plan" confirm=true` will
surface a clear Jira 403/400 error instead of silently failing.

## `export_report` (a.k.a. `hr_menu`'s "Create timesheet") — explicit scope (do not silently expand)

This is a **read/compute + write** action targeting a shared company
spreadsheet, so treat it with the same care as any other "visible to
others" action: tell the user what it's about to do (create-or-update
`Timesheet <Mon> <Year>` in the configured folder) before running it the
first time for a given month — it doesn't need a preview/confirm *text*
step like the Slack tools, because nothing is destroyed (only the tabs
described above are cleared and rewritten; other tabs are untouched, and
clearing+rewriting is what makes re-runs idempotent), but it does touch a
shared file so don't run it silently without the user knowing which month
it's about to (re)generate.

Same period-preset rule as `logtime`/`missing_logtime`: when HR wants to
create/update the timesheet without naming a month, always offer the 2
choices — Tháng này / Tháng trước — and pass the pick as `period`
(`thisMonth`/`lastMonth`) to `action="run"`, not a hand-typed `month`
(`resolveMonthPeriod` in `lib/dates.js`, shared with `set_hae_misc.js`,
handles the December/January rollover correctly in both directions).

**`action="notify"`** — after a successful `action="run"`, always ask HR
if they want to announce the timesheet on Slack. Same preview → edit →
confirm discipline as every other Slack-sending tool here: `action=
"notify"` with no `confirm` shows the **full** message (persisted to
`config/export_report_run.json` alongside the last run's month/year/file
so notify doesn't need its own month argument), editable via `message=`,
only `action="notify" confirm=true` actually posts to `#vn-absence`.
Never use a Slack MCP tool for this.

The message template (`buildTimesheetAnnounceMessage`) has real date
fields that must stay dynamic, not hardcoded — verified against a real
run: `[TIMESHEET <MONTH> <YEAR>]` and "timesheet for `<Month> <Year>`"
come from the report that was just generated (`run.monthIndex`/`run.
year`); "before 17:00 today `<Mon> <day>th`" uses **today's actual date**
when notify is called (not the report's month) since the deadline is
relative to whenever HR actually sends this, not to the reported period;
"Remained paid leave `<year-1>` will be expired on 1st Jul `<year>`" uses
today's calendar year as a standing annual-leave-expiry reminder — don't
hardcode any of these back to literal strings.

- **Three-part fix for a real, confirmed production bug** where a
  company-wide scan intermittently mislabeled someone's real MISC
  worklog as `ISSUE-<id>` and wrongly flagged them as not having logged
  it, even right after "fixing" it once (each fix attempt was verified
  against real data and still reproduced before the next one landed —
  don't assume a single-cause diagnosis without re-testing):
  1. **`resolveIssueKey()` (`scripts/lib/tempo.js`) only caches
     successful lookups, never failures.** Tempo's worklog payload only
     carries the Jira issue *id*, not its key, so every worklog needs a
     lookup to find out which ticket it's actually on. Caching a failed
     lookup as a permanent "this id has no key" meant one transient
     error mislabeled that worklog for the rest of the server process's
     life. Don't reintroduce caching a failure.
  2. **`jiraGet` (`scripts/lib/jira.js`) retries transient failures** (429
     rate-limit, 5xx, network errors) with backoff — fix #1 alone still
     produced a wrong result *within the same run* if the lookup failed
     during that run's own burst, since there was nothing to retry into.
     Retry is GET-only, on purpose — retrying a POST/DELETE after a lost
     response could silently duplicate a Jira ticket or worklog.
  3. **`jiraGet` caps concurrent requests to 10** (same file) — a
     company-wide scan resolves dozens of distinct issue ids/identities
     via one `Promise.all`; firing them all at once is what was
     triggering the rate-limit errors in the first place. This lives in
     `jira.js` itself (not each caller) so every GET benefits without
     having to remember to wrap it — don't reintroduce a per-caller
     limiter like `resolveIssueKey`'s first draft of this fix had.
  4. **Separately, `missing_logtime.js`'s per-account identity resolution
     loop was sequential** (`for` + `await`, not `Promise.all`) even
     though the `wrongAbsence` check needs every logged-time account's
     identity, not just the ones missing logtime — 60-90+ people
     resolved one-by-one pushed a single scan past 60 seconds (timed out
     against the default MCP client timeout). Fixed by resolving all
     accounts' identities in parallel; the GET limiter in #3 is what
     keeps that parallel burst from re-triggering the rate-limit problem
     #1-#3 exist to fix. Verified end-to-end after all four fixes: 3
     consecutive fresh-process scans of the same real week all correctly
     excluded a since-confirmed-logged person, completing in ~20s instead
     of 62s.
- **Discovery has no roster or config list of employees.** `run` calls
  `fetchCompanyWorklogsInRange(from, to)` (in `scripts/lib/tempo.js`) —
  Tempo's `/4/worklogs` endpoint with no user filter, paginated via
  `metadata.next` — which returns every worklog company-wide for the
  period. Grouping those by `author.accountId` already gives the exact set
  of people who logged anything that month (verified: a full month
  surfaced 88 real employees with no manual list). Each accountId's
  identity is then resolved via `getJiraUser()` (in `scripts/lib/jira.js`,
  cached). Don't reintroduce a roster/employee-list file — it was tried and
  removed as unnecessary complexity once this was discovered.
- **`Jira log`** tab = every discovered person with `> 0` logged hours that
  month, one row each, matching a Tempo Team-Timesheet-Report export shape
  (`Full name, User Account ID, Logged/Billable/Planned/Required
  Hours+Seconds, Progress, Period, <day columns>`). Verified against the
  template's real June 2026 data — exact match, including odd values like
  a `10` on a day that wasn't a plain `7`.
- **`Jira absence`** tab = same shape, but only hours logged on tickets
  matching `companyTimesheet.miscTicketPattern` / `haeTicketPattern`
  (default `MISC-\d+` / `HAE-\d+`). Also verified exact match — including
  the case where one person logs the same day split across two rotating
  MISC tickets (e.g. `MISC-50` for June, `MISC-51` for July) — both get
  summed, no special-casing needed since the regex matches any number.
- **`Jira OT`** tab = `User, Overtime, Key, Logged, <day columns>` (blank,
  not `0`, for non-OT days — matches the template). Overtime is **not**
  inferable from ticket key or comment text — it's tracked via a Tempo work
  attribute the user ticks while logging time (`_Overtime_`, a checkbox).
  Confirmed directly against real worklog data: ticked entries carry
  `attributes.values: [{ key: "_Overtime_", value: "true" }]`.
  `scripts/lib/tempo.js`'s `isOvertimeWorklog()` checks exactly that — don't
  reintroduce keyword/ticket-pattern guessing for OT.
- `Progress` = `round(Logged Hours / Required Hours * 100)`, verified
  against the template (e.g. 157/154 → 102). `Required Hours` = weekdays in
  the month × 7 (no holiday adjustment — matches the template, which shows
  the same flat number regardless of holidays that month).
- `Period` (the column right before the day grid, despite its header name)
  holds a submission/approval status string in the template (e.g. "Ready to
  submit") that isn't derivable from Jira/Tempo — left blank rather than
  guessed. `Billable Hours/Seconds` mirror `Logged Hours/Seconds` (every
  sample row in the template had them equal; no separate billable flag was
  found on the worklogs). `Planned Hours/Seconds` are always `0` (Tempo
  Planning data was not fetched — out of scope).
- Payroll-only columns from the master sheet seen while designing this
  (Old/Salary/New, leave balances, seniority, bonus leaves) are out of
  scope entirely.

### `WFH` tab — a different data source entirely

`WFH` has one row per employee (keyed by `CODE`, matching the static list
in `Timesheet '!A:C` — that CODE↔JIRA-name list is part of the template
itself, not generated by this server) and one column per calendar month
(`E`=Jan…`P`=Dec, plain hour totals, **not formulas** — confirmed by
reading with `valueRenderOption=FORMULA` and seeing literal numbers).
There is no way to derive WFH from Jira/Tempo data — it comes entirely from
the **`wfh-request` Slack channel** (`C0ALU4JK2UF` — note this is a
*different* channel from `vn-overtime-request`/`C085ZJJQ59Q`, which is OT
requests only; verified by scanning 6 months of the OT channel and finding
zero WFH mentions before finding the right one).

**Deliberate exception to "never write to the master template":** every
other tab/cell this server writes only ever targets the per-month copy —
but per explicit HR request, `WFH` is the one tab where the template
itself also gets the current month's column written, in addition to the
copy. `exportReportRun` calls `computeWfhHours()` (Slack scan + Jira
identity resolution) exactly ONCE, then `writeWfhToSheet()` twice with
that same result — once per `file.id`, once per `ct.templateFileId`.
**Don't go back to scanning Slack separately per target** — verified
against real data that doing so lets a genuinely new WFH Slack message
posted in the few seconds between the two calls get counted in the
second scan but not the first, leaving the two sheets with silently
different totals for the same month. This is intentionally narrow: still
only the `WFH` tab's one month-column, never anything else in the
template. Don't generalize this into "also update the template" for
`Jira log`/`Jira absence`/`Jira OT`/`Timesheet `/`OT`/`MISC` — those still
must never
touch the template, that constraint wasn't relaxed, only WFH specifically
was.

- **Message shape** (real, sampled): always first-person ("I would like to
  WFH today afternoon (7/7)..."), never posted on someone else's behalf.
  Hour mapping (given by HR, not inferred): "morning" → 3h, "afternoon" →
  4h, no time-of-day keyword → 7h (full day).
- **Which date it applies to**: an explicit parenthesized date always wins
  (`(7/7)`, `(July 7th)`, `(6 July)`, `(June 30)` — several formats seen in
  the wild, all handled by `extractExplicitDate` in `scripts/lib/wfh.js`).
  Without one, "tomorrow" shifts the message's own send date by a day;
  anything else ("today", "this morning/afternoon", or no date at all)
  defaults to the day the message was sent (`dateFromUnixVN(ts)` — must be
  Vietnam-time, not UTC, or late-night messages get misdated by a day).
- **Caching**: `config/wfh_cache.json` (gitignored) stores every parsed
  entry plus a `lastScannedTs` checkpoint. `scanWfhChannel()` only fetches
  Slack messages newer than that checkpoint on each call — never re-scans
  the whole channel history. This is also how "HR asks Claude about WFH
  without re-querying Slack" works: the cache is plain JSON, so answer
  ad-hoc questions by reading `config/wfh_cache.json` directly (`Read`
  tool) instead of calling `export_report` — only that tool call (which
  always calls `scanWfhChannel` internally) fetches new data.
- **Person resolution**: message author (Slack user ID) →
  `getSlackUserEmail()` → `findJiraUserByEmail()` → Jira display name →
  matched against the `Timesheet '!A:C` CODE list, **trimmed on both
  sides** before comparing (at least one real Jira account had a leading
  space in its `displayName` that silently broke an exact-string match
  despite the person genuinely having a CODE row — don't remove the
  `.trim()` calls in `computeWfhHours`/`writeWfhToSheet`). Two distinct failure modes get
  surfaced separately, don't conflate them: (a) Slack→Jira resolution
  fails entirely (no email, or no matching Jira account) — `⚠️ WFH: không
  resolve được Jira cho N Slack user`; (b) resolved to a real Jira identity
  but that person isn't in the template's CODE list (e.g. a new hire not
  yet added) — `⚠️ WFH: N người không có trong danh sách CODE`.

## `missing_logtime` discipline (a.k.a. `hr_menu`'s "Check Company time log")

Same governed flow as PM Assistant's `po_plan`/`sprint_report`/
`overtime_log` tools: `action="scan"` (read-only, saves results to
`config/missing_logtime_run.json`) → `action="notify"` (preview only,
never sends) → `action="notify", confirm=true` (sends, only allowed after
a preview was shown in this same run). Never call `confirm=true` on the
first call. Edits: `action="notify", message="..."` without `confirm`
shows the edited preview again — loop that as many times as needed before
confirming.

**Show `action="scan"`'s result to HR verbatim — never paraphrase or
summarize it into shorter prose.** Reported as a real incident: a
Desktop-app session collapsed the per-person, per-day breakdown into a
condensed name-list sentence, which is exactly the kind of rewrite that
can silently drop or distort a detail HR needed to catch (this happened
at the same time as a real data bug below, making it doubly hard for HR
to tell "is this actually wrong" from "did Claude just say it wrong").
Same rule for `logtime`'s `action="check"` — relay the returned text
as-is, don't compress it into a summary.

Same period-preset rule as `logtime`'s "Check my time log" task: when HR
wants to check company-wide time log without naming a date range, always
offer the same 4 choices — Tuần này / Tuần trước / Tháng này / Tháng
trước — and pass the pick as `period` to `action="scan"`
(`resolvePeriod` in `lib/dates.js`, shared with `logtime.js` so both
tools compute the same boundaries the same way).

`action="scan"` now reports **two independent categories**, both saved
into `config/missing_logtime_run.json` and both included when
`action="notify"` builds the Slack message:

1. **Thiếu log time** — total logged hours that day < 7h (the original
   check, unchanged).
2. **Đã khai nghỉ/đi muộn/về sớm trên Slack nhưng chưa log đủ vào MISC**
   — cross-checks every employee's own messages in `#vn-absence` (đi
   muộn/về sớm/xin nghỉ/wfh/leave keywords) against their actual Tempo
   worklogs on that month's MISC ticket. Only evaluated on days NOT
   already in category 1 (a day with too few total hours is already
   covered there; this catches the case those miss — someone logs a full
   day to an unrelated project ticket while having announced an absence,
   so the total-hours check alone sees nothing wrong). Skipped entirely
   for months where the MISC key isn't known yet (can't verify without
   it) and for people whose Slack ID didn't resolve (can't attribute
   messages to them).

**Where the message data comes from** (`getMonthAbsenceData` in
`lib/absence_cache.js`, shared with `logtime.js`): checks
`config/absence_cache.json` first for that month; if the entry is fresh
(current month: fetched today; past months: fetched ever) it's used
as-is; otherwise it re-scans `#vn-absence` for that whole month and
overwrites the cache entry. Unlike `logtime.js` (which only needs its
one HR's own messages), this cache entry's `messages` array holds every
message from every author that month — don't reintroduce a
per-person-filtered cache here, `missing_logtime.js` needs everyone's.
