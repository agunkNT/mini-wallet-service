# TODO & Implementation Progress

## 1. Project Setup & Infrastructure
- [x] Initialize `.env` from `.env.example`
- [x] Inspect existing starter migrations and models (`Member`, `Wallet`)
- [x] Ensure Docker PostgreSQL can run smoothly (`npm run db:up`) or configure DB credentials

## 2. Database Schema & Models Design
- [x] **Migration 1: Funding Transactions**
  - Table: `funding_transactions`
  - Columns: `id` (UUID), `member_id` (UUID), `wallet_id` (UUID), `type` (ENUM: `deposit`, `withdrawal`), `amount` (DECIMAL 36,18), `turnover_multiplier` (INTEGER), `status` (ENUM: `pending`, `completed`, `failed`), `psp_ref` (VARCHAR, UNIQUE indexed), `metadata` (JSONB), timestamps.
- [x] **Migration 2: Wallet Transactions (Append-Only Ledger)**
  - Table: `wallet_txs`
  - Columns: `id` (UUID), `wallet_id` (UUID), `reference_id` (UUID, nullable), `reference_type` (VARCHAR: `funding_tx`, `wager`), `type` (ENUM: `credit`, `debit`), `amount` (DECIMAL 36,18), `balance_before` (DECIMAL 36,18), `balance_after` (DECIMAL 36,18), timestamps.
- [x] **Migration 3: Turnover Tracking**
  - Update `wallets` or create dedicated turnover tracking (e.g., `required_turnover`, `accrued_turnover` on wallet or derived table). Keeping running totals on `wallets` with pessimistic row locking (`SELECT ... FOR UPDATE`) guarantees race-free updates and O(1) checks.
- [x] Define Sequelize Models & Associations (`FundingTransaction`, `WalletTx`, update `Wallet`).

## 3. Business Logic & Services
- [x] **Deposit Flow (`depositService` / `fundingService`)**:
  - `createDeposit(memberId, amount, turnoverMultiplier)` -> inserts `pending` funding tx with unique `pspRef`.
- [x] **PSP Callback Flow (`pspService`)**:
  - `handleCallback(pspRef, status, amount)`:
    - Atomicity: Transaction with pessimistic row-lock on funding transaction (`FOR UPDATE`).
    - Guard: Check if state is already `completed`/`failed` (idempotency exit).
    - Amount validation: verify callback amount vs deposit amount.
    - If `completed`:
      - Lock member wallet (`FOR UPDATE`).
      - Credit wallet balance using `BigNumber`.
      - Increase `required_turnover = required_turnover + (amount * multiplier)`.
      - Insert ledger entry into `wallet_txs`.
      - Update funding tx to `completed`.
- [x] **Wager Flow (`wagerService`)**:
  - `recordWager(walletId, amount)`:
    - Transaction with `SELECT ... FOR UPDATE` on `wallets`.
    - Check if `balance >= amount`. Reject with 422/400 if insufficient.
    - Debit balance, increase `accrued_turnover = accrued_turnover + amount`.
    - Write ledger row (`debit`, `balance_before`, `balance_after`).
- [x] **Withdrawal Flow (`withdrawalService`)**:
  - `createWithdrawal(memberId, amount)`:
    - Transaction with `SELECT ... FOR UPDATE` on `wallets`.
    - Check turnover condition: `accrued_turnover >= required_turnover`.
    - If false: Reject with 422 returning `{ error: "Turnover requirement not met", required, accrued, remaining }`.
    - Check balance: `balance >= amount`.
    - Debit balance, write ledger row, insert `funding_transactions` with type `withdrawal`, status `pending`.

## 4. API Endpoints & Validations
- [x] `POST /deposits` (Zod schema: memberId uuid, amount positive decimal string, turnoverMultiplier optional int >= 0).
- [x] `POST /psp/callbacks` (Zod schema: pspRef string, status completed|failed, amount decimal string).
- [x] `POST /wallets/:walletId/wagers` (Zod schema: amount positive decimal string).
- [x] `POST /withdrawals` (Zod schema: memberId uuid, amount positive decimal string).
- [x] Mount routes into `src/app.ts`.

## 5. Automated Tests (`test/`)
- [x] Unit & Integration tests using Jest & Supertest.
- [x] `test/deposit.test.ts`: Create deposit, happy callback, status change.
- [x] `test/concurrency.test.ts`:
  - Duplicate sequential callback (no double credit).
  - Parallel concurrent callbacks (`Promise.all`) test exact-once crediting.
  - Concurrent wagers test overdraw protection.
- [x] `test/withdrawal.test.ts`:
  - Withdrawal blocked when turnover requirement not met (422).
  - Withdrawal allowed when accrued turnover >= required turnover.
  - Balance debited and pending withdrawal created.

## 6. Deliverable Documentation
- [x] Write `DECISIONS.md`:
  - Concurrency & Locking Strategy (DB-level row locks `FOR UPDATE`, idempotency keys).
  - Schema decisions & double-entry ledger design.
  - Handling callback amount mismatch edge-case.
  - AI tools usage disclosure.
- [x] Write `DESIGN-PSP.md`:
  - Part B Architecture: Pluggable PSP Adapter Pattern, Webhook normalization, Config-driven provider registry, Mock testing strategy for CI.
