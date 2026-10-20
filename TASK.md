# TASK: Backend Lead Take-Home Challenge (99Tech / S5 Tech)

## 📌 Context & Objective
Build a regulated, real-money transactional platform handling deposits, wagers, and withdrawals with absolute **money correctness** guarantees.
- Time Budget: ~4 hours (~3 hours coding + 45 minutes design note).
- Stack: TypeScript, Express, Sequelize, PostgreSQL, Jest, Docker.
- Conventions: Money never touches JS `number` (using `bignumber.js` and strings at API boundaries). DB transactions for multi-table writes.

---

## 🎯 Requirements Breakdown

### Part A: Deposit → Wager → Withdrawal Flow (~3h)

1. **A1. Create a Deposit (`POST /deposits`)**
   - Payload: `{ "memberId": "<uuid>", "amount": "100.50", "turnoverMultiplier": 1 }`
   - Validation: `amount` positive decimal string, `turnoverMultiplier` integer >= 0 (default 1).
   - Action: Create a funding transaction with status `Pending`, generate a unique `pspRef`. No wallet balance changes yet.
   - Response: `201 Created` with transaction id and `pspRef`.

2. **A2. Handle PSP Callback (`POST /psp/callbacks`)**
   - Webhook payload: `{ "pspRef": "<ref>", "status": "completed"|"failed", "amount": "100.50" }`
   - Hostile Infrastructure Concerns:
     - **Idempotency (Sequential)**: Duplicate callbacks must never double-credit the wallet.
     - **Concurrency (Parallel requests)**: Concurrent callbacks with the same `pspRef` arriving simultaneously must be safely handled (database row locks / unique constraint). Exactly 1 request succeeds in crediting.
     - **Amount mismatch handling**: If callback amount differs from the original deposit, apply strict policy (e.g., reject, mark failed, document in `DECISIONS.md`).
     - **Unknown pspRef**: Return `404 Not Found`.
   - Requirements:
     - Wallet credited **exactly once**.
     - Write to append-only ledger (`wallet_txs` / transactions log) ensuring balance is always mathematically reconstructible.
     - Funding transaction status transition: `Pending -> Completed / Failed`. Reject invalid state transitions.

3. **A3. Record Wagers (`POST /wallets/:walletId/wagers`)**
   - Payload: `{ "amount": "10.00" }`
   - Action: Debit wallet (reject with `422/400` if balance is insufficient).
   - Accrue turnover (increment total turnover played).
   - Concurrency: Concurrent wagers must never cause a negative balance (overdraw protection via `SELECT ... FOR UPDATE`).
   - Write ledger entry.

4. **A4. Withdrawals with Turnover Lock (`POST /withdrawals`)**
   - Payload: `{ "memberId": "<uuid>", "amount": "50.00" }`
   - Business Rule (Anti-Abuse):
     - Each completed deposit adds **turnover requirement** = `amount * turnoverMultiplier`.
     - Each wager adds **accrued turnover** = `wager amount`.
     - Withdrawal is ONLY permitted if **accrued turnover >= total required turnover**.
     - If requirement not met: return `422 Unprocessable Entity` with remaining turnover details.
   - If valid: debit wallet immediately, record ledger entry, and create a funding transaction with status `Pending`.

5. **A5. Test Suite (Jest)**
   - Minimal Test Scenarios:
     - Duplicate callback (sequential) does not double-credit.
     - Concurrent duplicate callbacks do not double-credit.
     - Concurrent wagers cannot overdraw wallet.
     - Turnover lock blocks and unblocks withdrawal correctly.
     - Normal happy paths for deposit, wager, withdrawal.

---

### Part B: Design Note - The 50th PSP (`DESIGN-PSP.md`) (~45 min)
- Topic: *"How would you structure this codebase so that integrating a new PSP is a one-day task safely done by a junior engineer?"*
- Scope:
  - Abstraction & Provider Interface (`PSPAdapter`).
  - Request/Webhook verification & payload normalization.
  - Configuration-driven architecture.
  - Testing strategy (Contract testing, Mock server, sandbox isolation).
- Format: Max ~1 page + sketch / diagram.

---

### Deliverables Checklist
- [x] Codebase working under `src/` (models, migrations, services, routes).
- [x] Comprehensive test suite under `test/`.
- [x] `DECISIONS.md` (Design choices, concurrency locking strategy, assumptions, trade-offs, AI disclosure).
- [x] `DESIGN-PSP.md` (Part B architecture write-up).
