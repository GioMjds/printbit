# PrintBit mobile `/admin` redesign: design spec

Date: 2026-10-29
Status: design approved by Gio in three sections; awaiting spec review
Scope: mobile layout (≤860px) of the existing `/admin` panel. Desktop layout is unchanged.

## 1. Goal and primary job

Staff open `/admin` on their phone, on the PrintBit Wi-Fi, next to the machine. The #1 job of the mobile UI is **triage within about 5 seconds**: is the machine OK, and what needs attention right now (paper jam, low ink, owed change, open anomalies)?

Everything else is secondary and must stay reachable but out of the way.

## 2. Problems with the current mobile layout

- At ≤480px the sidebar becomes a permanent 68px icon-only rail (about 16% of a 425px screen) with 9 unlabeled icons.
- Nav badges are hidden on mobile (`.nav-count-badge { display: none !important }`), so open alerts, reports and feedback are invisible.
- The top bar shows only the page title and Refresh; machine health is not visible anywhere.
- The Overview is the desktop layout restacked into one column. Reset/clear buttons carry the same visual weight as read-only stats, including the destructive Clear Upload Storage.
- Refresh errors appear in `.topbar__msg`, which is hidden at ≤480px, so a failed poll is silent.
- Each page's `admin-page-hero` block takes about 120px of the first screen.

## 3. Constraints

- All 9 existing tabs stay reachable in one tap: Overview, Earnings, System, Settings, System Logs, Transaction Logs, Feedback, Reports, Anomaly Alerts.
- Admin PIN auth gate, PWA install prompt and offline banner are unchanged.
- Existing element IDs written by `app.ts` (`earningsToday`, `jobsTotal`, `inkFill*`, and so on) are kept so `applySummary` keeps working.
- The existing `min-height: 44px` tap-target rule in `globals.css` applies to all new interactive elements.
- Theme tokens (`--indigo`, `--peach`, `--green`, `--amber`, `--red`, Plus Jakarta Sans) are reused; no new palette.

## 4. Design

### 4.1 Navigation shell (≤860px)

- The 68px icon rail and the 860px/480px rail rules in `shared.css` are replaced by a drawer.
- **Top bar:** menu button (left), page title, Refresh (right). A small "Updated Ns ago" label sits under the title.
- **Menu button badge:** the sum of open anomaly alerts, open reports and open feedback (everything open). Hidden at 0, displayed as "9+" above 9. Decision confirmed by Gio.
- **Drawer:** slides in from the left at about 78% width over a dimmed scrim. It closes on tab tap, scrim tap, or swipe back.
- **Drawer contents,** grouped by intent:
  - Monitor: Overview, Earnings, Anomaly Alerts
  - Support: Reports, Feedback
  - Records: System Logs, Transaction Logs
  - Machine: System, Settings
  - Lock Panel, separated at the bottom in danger colour
- Each row shows its own count where one exists (Alerts, Reports, Feedback). Rows are at least 44px tall.
- At >860px the existing sidebar is untouched.

### 4.2 Overview screen

Top to bottom:

1. **Status banner**
   - Red "Machine needs you": any critical item open.
   - Amber "N need attention": only warnings open.
   - Green "All clear": nothing open.
   - Grey "Can't reach kiosk": the 10s poll failed. This state is visible on mobile, unlike the current hidden message.
2. **Attention queue:** one row per open item, one action each, sorted by severity then recency.

   | Item              | Severity | Trigger                                           | Action              |
   | ----------------- | -------- | ------------------------------------------------- | ------------------- |
   | Paper jam         | Critical | printer-error state (not yet exposed to `/admin`) | Clear               |
   | Owed change       | Critical | `owedChangeOpenCount > 0`                         | Settle              |
   | Anomaly alerts    | Warning  | `anomalyStats.openCount > 0`                      | Open Anomaly Alerts |
   | Ink low           | Warning  | `inkEstimation.*.alertTriggered`                  | Open Machine health |
   | Paper running out | Warning  | `consumables.alerts.withinThreshold`              | Open Machine health |

   When the queue is empty it is replaced by one line: "Nothing needs you right now."

3. **Today and Jobs:** a 2-up stat pair (`earningsToday`, `jobsTotal`).
4. **Machine health:** a collapsed strip with Paper, Grayscale % and Color % as thin horizontal bars; storage (`storageBytes`, `storageFiles`) lives here. Expanding shows full gauges and the per-printer consumables forecast. Vertical 140px ink tanks become horizontal bars on mobile.
5. **Job breakdown:** the Print/Copy/Scan bars, mostly unchanged.
6. **Maintenance:** a collapsed section with Reset Balance, Reset Ink Counters and Clear Upload Storage. Clear Upload Storage is visually separated and red. All three keep their existing confirm prompts.

### 4.3 Other pages inside the same shell

Shared frame: `admin-page-hero` collapses to a one-line title; content padding 14px; offline banner stays sticky.

| Page             | Mobile treatment                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Earnings         | Today/week/month switcher, large total, full-width chart with fixed height or a simple list breakdown.             |
| System           | One card per subsystem (printer, ESP32, hopper, worker) with status dot and last-seen time; details expand on tap. |
| Settings         | Grouped section cards. Helper text raised to 13px at higher contrast. See the save-behaviour rule below.           |
| System Logs      | Card list (time, level colour, two-line message), level filter chips on top, tap to expand.                        |
| Transaction Logs | Card per transaction (`PB-YYYYMMDD-XXXX`, amount, type, status), search box on top, tap for detail.                |
| Feedback         | Inbox list with unread dot; detail view with Archive (not hard delete).                                            |
| Reports          | Same inbox pattern, plus the linked transaction and a resolution reason picker.                                    |
| Anomaly Alerts   | Same inbox pattern grouped by severity; Resolve is the single primary action.                                      |

Pattern rules:

- Tables become card lists below 640px: at most two lines per row, expandable detail.
- Feedback, Reports and Anomaly Alerts share one inbox component.
- Filters are a chip row at the top of the list, never in a modal.
- Destructive actions always confirm and never sit next to a primary action.
- **Settings save behaviour:** implementation first reads the Settings code. If changes are batched, show a sticky "Save changes" / "Discard" bar only while the form is dirty. If each toggle saves immediately, omit the bar and show an inline "Saved" state per toggle.

## 5. Data and code impact

- No new endpoint for the nav badge: it sums the existing `openAlertBadge`, `openReportBadge` and `openBadge` values.
- The status banner and attention queue are built client-side from the existing `SummaryResponse`.
- Changes are mostly CSS (`shared.css`, `dashboard/styles.css`) and additive markup in `index.html`; `app.ts` gains the banner/queue rendering, the "Updated Ns ago" label and the failed-poll state.
- A small shared module owns the drawer open/close behaviour so every admin page loads it once.

## 6. Verify before implementation

These were not visible in the files reviewed for this design:

1. Whether `updateSidebarBadges` fills all three badge counts on every page, not only Overview.
2. Whether the backend exposes printer-error state (Paper Jam) to `/admin`. If not, the Paper jam row is added in the same change that adds the clear-jam control; the queue is built so the row can be added without layout changes.
3. The real markup and CSS of Earnings, System, System Logs, Transaction Logs, Feedback, Reports and Alerts; only Overview and a Settings screenshot were reviewed.
4. How Settings saves (see 4.3).

## 7. Out of scope

- Changes to the desktop layout.
- A bottom tab bar (rejected: it duplicates what the Overview shows and costs vertical space).
- New backend endpoints other than the optional printer-error state above.
- Changing the admin PIN or auth flow.

## 8. Testing

- Visual check at 360, 390, 425 and 768px widths, and at 860px (breakpoint boundary).
- Drawer: opens and closes by menu button, scrim and swipe; focus returns to the menu button; Escape closes it.
- Badge: shows 0 (hidden), a middle count and "9+".
- Banner: each of the four states, including simulating a failed poll.
- Tap targets are at least 44px; text is at least 13px for helper copy.
- Reset and clear actions still prompt for confirmation.
