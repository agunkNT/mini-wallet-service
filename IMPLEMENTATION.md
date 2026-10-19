# Implementation Plan: Mini Wallet Service & Money Movement Engine

## 1. Architectural Principles
1. **Zero Money Leakage (Money Correctness is Existential)**:
   - Money values are never converted to JavaScript floating point numbers (`number`). All computations occur via `BigNumber` (18-decimal precision) and are stored in PostgreSQL as `DECIMAL(36,18)`.
   - Any money movement must be recorded in an immutable, append-only ledger (`wallet_txs`), guaranteeing auditability and historical balance reconstruction.
2. **Idempotency & Concurrency Safety**:
   - Webhook callbacks from payment providers arrive concurrently and repeatedly.
   - Idempotency is enforced through database transactions combined with pessimistic row-level locking (`SELECT ... FOR UPDATE` on both `funding_transactions` and `wallets`).
   - Strict status transition state machine: `pending` -> `completed` or `failed`. Any subsequent attempt on an already completed/failed transaction is gracefully treated as a no-op (returning idempotent 200).
3. **Turnover Locking (Anti-Abuse Rule)**:
   - Each completed deposit locks in a turnover quota: `requiredTurnover += amount * turnoverMultiplier`.
   - Each wager contributes towards meeting the quota: `accruedTurnover += wagerAmount`.
   - Withdrawals are gated by `accruedTurnover >= requiredTurnover`. An unfulfilled requirement results in `422 Unprocessable Entity` with transparent remaining turnover data.

---

## 2. Database Schema Design

### 2.1 Existing Tables
- `members` (`id`, `name`, `email`, timestamps)
- `wallets` (`id`, `member_id`, `balance`, `currency`, timestamps)

### 2.2 Schema Extensions
We will add:
- **Columns on `wallets`**:
  - `required_turnover`: `DECIMAL(36, 18)` DEFAULT `'0'`
  - `accrued_turnover`: `DECIMAL(36, 18)` DEFAULT `'0'`
  *Rationale*: Storing running totals directly on the locked wallet row provides O(1) withdrawal checks without expensive aggregate scans, with guaranteed consistency because all updates happen within row-locked transactions.

- **New Table: `funding_transactions`**:
  - `id`: UUID (Primary Key)
  - `member_id`: UUID (Foreign Key -> members)
  - `wallet_id`: UUID (Foreign Key -> wallets)
  - `type`: ENUM (`'deposit'`, `'withdrawal'`)
  - `amount`: `DECIMAL(36, 18)`
  - `turnover_multiplier`: `INTEGER` DEFAULT 1
  - `status`: ENUM (`'pending'`, `'completed'`, `'failed'`) DEFAULT `'pending'`
  - `psp_ref`: `VARCHAR(255)` UNIQUE (Indexed) - generated opaque token for PSP tracking
  - `raw_callback_payload`: JSONB (nullable, for audit trail)
  - `created_at`, `updated_at`: TIMESTAMPTZ

- **New Table: `wallet_txs` (Append-Only Ledger)**:
  - `id`: UUID (Primary Key)
  - `wallet_id`: UUID (Foreign Key -> wallets)
  - `reference_id`: UUID (Nullable - points to `funding_transactions.id` or `wager.id`)
  - `reference_type`: VARCHAR (`'deposit'`, `'withdrawal'`, `'wager'`)
  - `type`: ENUM (`'credit'`, `'debit'`)
  - `amount`: `DECIMAL(36, 18)`
  - `balance_before`: `DECIMAL(36, 18)`
  - `balance_after`: `DECIMAL(36, 18)`
  - `created_at`: TIMESTAMPTZ

---

## 3. Endpoints & Sequence of Operations

### 3.1 `POST /deposits`
1. Request: `{ "memberId": "uuid", "amount": "100.50", "turnoverMultiplier": 1 }`
2. Validate with Zod:
   - `memberId`: valid UUID string
   - `amount`: valid decimal string, positive (`> 0`)
   - `turnoverMultiplier`: integer `>= 0`, default 1
3. Query member and primary wallet. Return 404 if not found.
4. Generate crypto-secure `pspRef` (e.g. `psp_dep_<nanoId/uuid>`).
5. Insert into `funding_transactions` with `status = 'pending'`, `type = 'deposit'`.
6. Return `201 Created` with `{ id, pspRef, status: 'pending', amount }`.

### 3.2 `POST /psp/callbacks`
1. Request: `{ "pspRef": "ref", "status": "completed" | "failed", "amount": "100.50" }`
2. Start DB Transaction:
3. Query `funding_transactions` with `WHERE psp_ref = :pspRef FOR UPDATE`.
   - If not found -> Rollback & Return `404 Not Found`.
   - If status is already `'completed'` or `'failed'` -> Rollback & Return `200 OK` `{ message: "Already processed", status }` (Idempotent success).
4. Verify `amount`:
   - If callback amount differs from recorded deposit amount, mark transaction as `'failed'`, log incident, and return 400 or 200 with error log (to be detailed in `DECISIONS.md`).
5. If `status === 'completed'`:
   - Lock `wallets` row: `SELECT * FROM wallets WHERE id = :walletId FOR UPDATE`.
   - Calculate new balance: `newBalance = balance + amount`.
   - Calculate added turnover: `addedTurnover = amount * turnoverMultiplier`.
   - Update wallet: `balance = newBalance`, `required_turnover = required_turnover + addedTurnover`.
   - Insert into `wallet_txs`:
     - `wallet_id`: wallet.id
     - `reference_id`: fundingTx.id
     - `reference_type`: `'deposit'`
     - `type`: `'credit'`
     - `amount`: amount
     - `balance_before`: wallet.balance
     - `balance_after`: newBalance
   - Update `funding_transactions`: `status = 'completed'`.
6. If `status === 'failed'`:
   - Update `funding_transactions`: `status = 'failed'`.
7. Commit Transaction.
8. Return `200 OK`.

### 3.3 `POST /wallets/:walletId/wagers`
1. Request: `{ "amount": "10.00" }`
2. Validate: `amount` is positive decimal string.
3. Start DB Transaction:
4. Lock wallet: `SELECT * FROM wallets WHERE id = :walletId FOR UPDATE`.
   - Check `balance >= amount`. If not, rollback and return `422 Unprocessable Entity` `{ error: "Insufficient balance" }`.
5. Calculate:
   - `newBalance = balance - amount`.
   - `newAccruedTurnover = accrued_turnover + amount`.
6. Update wallet: `balance = newBalance`, `accrued_turnover = newAccruedTurnover`.
7. Insert into `wallet_txs`:
   - `reference_type`: `'wager'`
   - `type`: `'debit'`
   - `amount`: amount
   - `balance_before`: wallet.balance
   - `balance_after`: newBalance
8. Commit Transaction.
9. Return `200 OK` `{ walletId, balance: newBalance, accruedTurnover: newAccruedTurnover }`.

### 3.4 `POST /withdrawals`
1. Request: `{ "memberId": "uuid", "amount": "50.00" }`
2. Validate input parameters.
3. Start DB Transaction:
4. Lock member's wallet: `SELECT * FROM wallets WHERE member_id = :memberId FOR UPDATE`.
5. Check Turnover Lock:
   - `remainingTurnover = max(0, required_turnover - accrued_turnover)`
   - If `remainingTurnover > 0`:
     - Rollback & Return `422 Unprocessable Entity` with:
       ```json
       {
         "error": "Turnover requirement not met",
         "requiredTurnover": "100.50",
         "accruedTurnover": "20.00",
         "remainingTurnover": "80.50"
       }
       ```
6. Check Balance:
   - If `balance < amount`:
     - Rollback & Return `422 Unprocessable Entity` `{ error: "Insufficient balance" }`.
7. Deduct balance immediately:
   - `newBalance = balance - amount`.
   - Update wallet: `balance = newBalance`.
8. Create `wallet_txs` ledger entry (`debit`, `reference_type = 'withdrawal'`).
9. Create `funding_transactions`: `type = 'withdrawal'`, `status = 'pending'`, `amount = amount`.
10. Commit Transaction.
11. Return `201 Created` with withdrawal details.

---

## 4. Testing Strategy (Jest & Supertest)
1. **Idempotency & Replay Attack**:
   - Call `/psp/callbacks` twice sequentially -> Wallet credited only once.
2. **High Concurrency Parallelism**:
   - `Promise.all` 10 simultaneous identical callback requests -> Exactly one succeeds in crediting, others gracefully exit, balance verified with ledger.
   - `Promise.all` simultaneous wagers that would exceed balance -> Only valid count succeed, balance never drops below zero.
3. **Turnover Lifecycle**:
   - Deposit with multiplier -> try withdraw (fails 422).
   - Place wagers until required amount met -> withdrawal succeeds.
