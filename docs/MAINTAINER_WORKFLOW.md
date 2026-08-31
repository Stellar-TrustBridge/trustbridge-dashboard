# Maintainer Workflow

This flow keeps payout preparation predictable, secure, and fully audited.

## Core Payout Workflow

1. Ask contributors to register their GitHub username and Stellar address.
2. Review newly registered addresses in the dashboard.
3. Re-check readiness before exporting payment data.
4. Filter out accounts marked not ready.
5. Keep the exported CSV with the payout batch record.

For urgent payouts, contact contributors with the remediation text shown by the dashboard before changing thresholds.

---

## 1. Wave Roster Freeze Window (Issue #186)

To prevent roster changes or rechecks from shuffling readiness states immediately prior to wave payout settlement:

- **Configuration**:
  - Set `FREEZE_WINDOW_START` (ISO 8601, e.g. `2026-08-30T00:00:00Z`).
  - Set `FREEZE_WINDOW_END` (ISO 8601, e.g. `2026-09-02T00:00:00Z`).
  - Set `FREEZE_WINDOW_ENABLED=true` (or `false` to disable).
- **Behavior**:
  - Mutating operations (`POST /api/register/recheck`, address updates in `POST /api/register`) are blocked during an active freeze window with HTTP `423 Locked` (`code: WAVE_FREEZE_ACTIVE`).
  - Read operations (`GET /api/register`, dashboard viewing) remain fully operational.
  - Blocked attempts are logged in the audit log as `recheck.freeze_blocked` / `address_change.freeze_blocked`.
- **Maintainer Override**:
  - Maintainers can bypass an active freeze window when necessary by supplying header `x-freeze-override: true` or query param `overrideFreeze=true`.
  - Override operations are recorded in the audit log as `recheck.freeze_override` / `address_change.freeze_override`.

---

## 2. Horizon Latency Metrics (Issue #184)

- The maintainer metrics dashboard (`/dashboard/metrics`) aggregates `horizonLatencyMs` from Horizon address checks.
- Visualizes average latency, p50 (median), p95 latency, and total sample counts.
- Displays a clean empty state banner when no latency samples exist.

---

## 3. Mass Address Change Anomaly Detection (Issue #188)

- **Configuration**:
  - `MASS_ADDRESS_CHANGE_THRESHOLD`: Number of address changes triggering an alert (default `5`).
  - `MASS_ADDRESS_CHANGE_WINDOW_MINUTES`: Sliding window duration in minutes (default `60`).
- **Behavior**:
  - Non-blocking (fail open): User address changes continue to succeed.
  - When the threshold is breached within the sliding window, an audit event `anomaly.mass_address_changes` is recorded.
  - Prominent security alert banner is displayed on the maintainer dashboard warning of potential session compromise without exposing raw wallet addresses.

---

## 4. Contributor Ban & Unban Management (Issue #190)

- **Maintainer Actions**:
  - Maintainers can ban an abusive or compromised contributor via the maintainer dashboard or `POST /api/maintainer/ban` (`action: "ban"`, `githubUsername: "<username>"`, `reason: "<mandatory reason>"`).
  - Banning requires a non-empty reason and applies case-insensitively across current and future account re-registrations.
  - Maintainers can unban contributors via `POST /api/maintainer/ban` (`action: "unban"`, `githubUsername: "<username>"`).
- **Enforcement**:
  - Banned contributors attempting to register or recheck addresses are rejected with HTTP `403 Forbidden` (`code: USER_BANNED`).
  - All ban and unban actions record full audit trail events (`contributor.banned`, `contributor.unbanned`).
