# Technical Decisions & Architecture Trade-Offs

## 1. Concurrency & Locking Strategy
In a real-money transactional system, money movements must never tolerate lost updates or race conditions.

### Row-Level Pessimistic Locking (`SELECT ... FOR UPDATE`)
- **PSP Callbacks (`/psp/callbacks`)**:
  - We acquire an exclusive lock on `funding_transactions` via `lock: t.LOCK.UPDATE` where `psp_ref = :pspRef`.
  - Because `psp_ref` has a `UNIQUE` index in PostgreSQL, this lock targets exactly one physical row.
  - Concurrent webhook retries block until the initial transaction finishes. Once unlocked, secondary requests encounter `status !== 'pending'` and exit cleanly without double crediting.
  - When updating the wallet balance, we also acquire `lock: t.LOCK.UPDATE` on `wallets` by primary key, preserving lock ordering (`funding_transactions` -> `wallets`) to prevent deadlocks.
- **Wagers (`/wallets/:walletId/wagers`)**:
  - A wager must never overdraw the wallet. We acquire `lock: t.LOCK.UPDATE` on the `wallets` row before comparing `balance >= wagerAmount`.
  - Concurrent wagers are serialized strictly. If 5 wagers of $30 arrive simultaneously on a $100 wallet, exactly 3 succeed ($90) and 2 immediately reject with `422 Unprocessable Entity`.
- **Withdrawals (`/withdrawals`)**:
  - The wallet row is locked `FOR UPDATE`, ensuring simultaneous checks for turnover requirements and available balance cannot race against pending wagers or deposits.

---

## 2. Ledger Design & Balance Reconstruction (Double-Entry Principles)
- **Append-Only Table (`wallet_txs`)**:
  - Every balance mutation requires an immutable row in `wallet_txs`.
  - Captures: `wallet_id`, `reference_id` (funding transaction id or wager), `reference_type` (`deposit`, `withdrawal`, `wager`), `type` (`credit`, `debit`), `amount`, `balance_before`, `balance_after`, and `created_at`.
  - No `updated_at` column is provisioned, reinforcing append-only semantics.
  - **Auditability**: The current `wallets.balance` can always be verified and mathematically reconstructed:
    $$\text{Balance} = \sum \text{Credits} - \sum \text{Debits}$$

---

## 3. Turnover Tracking & Withdrawal Guard
- **Storage Strategy**:
  - Rather than scanning historical ledger rows during withdrawal (an $O(N)$ operation that slows as players transact), running totals `required_turnover` and `accrued_turnover` are persisted directly on the `wallets` table.
  - Because wallet mutations execute inside pessimistic row-locked transactions, these running totals maintain 100% ACID consistency.
- **Rules Enforced**:
  - Completed deposit: `required_turnover += deposit_amount * turnover_multiplier`.
  - Wager placed: `accrued_turnover += wager_amount`.
  - Withdrawal eligibility: `accrued_turnover >= required_turnover`.
  - If unsatisfied: rejects with `422` and returns a transparent breakdown (`requiredTurnover`, `accruedTurnover`, `outstandingTurnover`).

---

## 4. Edge Cases: Amount Mismatch & Hostile Webhooks
- **Amount Mismatch**:
  - If a PSP reports an amount differing from the initial deposit record (e.g., currency discrepancy, unauthorized provider modification), we treat it as an unverified state.
  - Decision: Transition the transaction to `status: 'failed'`, record diagnostic metadata (`expected`, `received`) in `raw_callback_payload` for compliance auditing, and return `400 Bad Request`. The wallet is **never** credited.
- **Unknown `pspRef`**:
  - Returns `404 Not Found` without modifying database state.

---

## 5. What I Would Do Next (With More Time)
1. **Outbox Pattern for External Notifications**:
   - Write events to a transactional `outbox` table within the same DB transaction to notify message brokers (e.g., Kafka/RabbitMQ) for analytics or CRM without coupling the HTTP request lifecycle.
2. **Periodic Reconciliation Worker**:
   - A background cron job running nightly SQL queries to assert `wallets.balance == SUM(wallet_txs)` across the entire estate, automatically raising alerts on any discrepancy.
3. **Optimistic Locking with Exponential Backoff for Read-Heavy Scenarios**:
   - For high-throughput scenarios where database lock contention on wallet rows spikes, evaluate conditional updates (`UPDATE wallets SET balance = balance + :amt WHERE version = :ver`) with bounded application-level retries.

---

## 6. AI Tools Disclosure
- Used Google Antigravity Agent to assist with scaffolding database migrations, generating boilerplate test fixtures for concurrency assertions (`Promise.all`), and structuring documentation. All business logic, transaction safety rules, and architectural trade-offs have been reviewed and owned.
