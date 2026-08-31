# Readiness Model

TrustBridge pays contributors in **USDC on the Stellar network**. Before a
payout can land, the contributor's wallet has to be able to accept it. The
dashboard reduces that question to three states, shown as a badge everywhere a
wallet appears.

This document is the source of truth for **the words** shown to contributors.
The algorithm behind the states lives in `computeReadiness()` in
[`src/lib/readiness.ts`](../src/lib/readiness.ts) and is not described by this
document beyond what a contributor needs to know.

## Who reads what

There are two audiences, and they get different text:

| Audience | Surface | Vocabulary |
| --- | --- | --- |
| Contributors | `TrustlineStatusBadge`, `TrustlineGuidancePanel`, `AddressInput` | Plain language. Any Stellar-only term is explained where it is used. |
| Maintainers | The per-row **Horizon debug** panel (`ContributorDebugPanel` in `ContributorTable`), CSV/JSON exports, `/dashboard/metrics` | Raw field names, balances, reason codes, Horizon latency. |

**Nothing jargon-heavy belongs in the contributor surfaces.** If a maintainer
needs a Horizon field name or a raw reason code, it goes in the debug panel or
the export, not in the badge.

## The three states

Copy is keyed by status in `READINESS_CONFIG` (`src/lib/readiness.ts`). Changing
the words means changing that record — and `src/lib/readiness-copy.test.ts` will
hold the new words to the same rules.

### ✅ Ready

**Badge:** Ready
**What it means:** This wallet is set up and can receive USDC payouts.
**What to do next:** Nothing to do — you are set for the next payout.

Underneath: the account exists on Horizon, it holds the configured asset
trustline, that trustline is authorized by the issuer, and spendable XLM meets
the configured minimum.

### ⚠️ Low balance

**Badge:** Low balance
**What it means:** This wallet can receive USDC, but it is running low on
XLM — the small deposit Stellar keeps locked in every wallet.
**What to do next:** Add a little more XLM so the wallet keeps working when the
payout lands.

Underneath: the account exists and holds an authorized trustline, but its
**spendable** XLM is below the configured threshold. A payout can still arrive;
subsequent operations may fail.

Spendable XLM is the raw native balance minus the Stellar minimum reserve
(`baseReserve * (2 + subentries + sponsoring − sponsored)`) and any
`selling_liabilities`. The raw balance alone can look healthy while the spendable
amount is near zero once trustlines, offers, or signers are accounted for. See
`computeSpendableXlmBalance()` in `src/lib/readiness.ts`.

### ❌ Not ready yet

**Badge:** Not ready yet
**What it means:** This wallet cannot receive USDC payouts yet.
**What to do next:** Follow the setup steps: put some XLM in the wallet, then
turn on USDC for it.

Underneath: the account is unfunded, the trustline is missing, the trustline is
present but not authorized by the issuer, or Horizon could not complete the
check. Maintainers should avoid payout export until the state changes.

## Reason codes

A status says *whether* a wallet can be paid. The reason code says *why not*, and
drives the single "what to do next" line the contributor sees. Reason codes are
computed by `computeNextAction()` and worded in `WIZARD_ACTION_COPY`, both in
[`src/lib/action-lookup.ts`](../src/lib/action-lookup.ts). They mirror the
reason codes emitted by
[trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action).

| Reason code | Status it produces | What the contributor is told |
| --- | --- | --- |
| `fund_account` | Not ready yet | Send at least 1 XLM to this address — a Stellar wallet does not exist until someone puts a little XLM in it. |
| `add_trustline` | Not ready yet | Turn on USDC for this wallet (Stellar calls this "adding a trustline"). |
| `await_trustline_authorization` | Not ready yet | USDC is turned on, but the issuer has not approved this wallet yet. |
| `increase_reserve` | Low balance | Add a little more XLM — Stellar keeps a small amount locked in every wallet as a deposit. |
| `none` | Ready | Nothing to do — this wallet can receive payouts. |

`computeNextAction()` checks these in order: funding, then trustline presence,
then issuer authorization, then reserve. The first failing check wins, so a
contributor is never handed two things to do at once.

Each entry in `READINESS_CONFIG` carries the `reasonCodes` it can be produced
by. `readiness-copy.test.ts` asserts that mapping against `computeNextAction()`
for every state, so a badge can never promise something the wizard contradicts.

## Rules for changing this copy

1. **Words only.** Never change `computeReadiness()` to make a copy change work.
2. **Explain the term where you use it.** "Trustline" and "reserve" are allowed
   only alongside a plain-language gloss. The test enforces this.
3. **No internal identifiers.** `low_reserve`, `trustline_authorized`,
   `spendable_xlm_balance` and friends never appear in contributor copy.
4. **One next step.** Every state ends with exactly one thing to do.
5. **Update this file and `readiness-copy.test.ts` in the same change.**

## README Readiness Badge Endpoint

Repositories can embed an SVG readiness badge in their README via `GET /api/badge/[username]?sig=...`.

### HMAC Integrity & Anti-Spoofing
- Badges require a valid HMAC-SHA256 signature (`sig`) generated with `signBadge(username, exp)`.
- Secret key resolved from `BADGE_SIGNING_KEY` (or `NEXTAUTH_SECRET` / `TOKEN_ENCRYPTION_KEY`).
- Optional expiration timestamp (`exp` in seconds) supported for short-lived signed URLs.
- Requests with missing, invalid, or expired signatures return `403 Forbidden`.

### Privacy & User Enumeration Protection
- Badges are public ONLY if the user has an active registration with `profilePublic: true`.
- Requests for private, missing, or soft-deleted profiles return an identical `404 Not Found` response.
- SVG output contains NO PII or Stellar addresses.

