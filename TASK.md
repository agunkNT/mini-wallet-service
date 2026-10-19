# TASK: Backend Lead Take-Home Challenge (99Tech / S5 Tech)

## 📌 Context & Objective
Membangun platform transaksional uang riil (regulated, real-money transactional platform) yang menangani deposit, wager (taruhan), dan withdrawal dengan jaminan integritas uang (**money correctness**) yang absolut.
- Time Budget: ~4 jam (~3 jam coding + 45 menit design note).
- Stack: TypeScript, Express, Sequelize, PostgreSQL, Jest, Docker.
- Konvensi: Money never touches JS `number` (menggunakan `bignumber.js` dan string di API boundary). DB transactions untuk multi-table writes.

---

## 🎯 Requirements Breakdown

### Part A: Deposit → Wager → Withdrawal Flow (~3h)

1. **A1. Create a Deposit (`POST /deposits`)**
   - Payload: `{ "memberId": "<uuid>", "amount": "100.50", "turnoverMultiplier": 1 }`
   - Validasi: `amount` string desimal positif, `turnoverMultiplier` integer >= 0 (default 1).
   - Action: Buat funding transaction dengan state `Pending`, generate `pspRef` yang unik. Belum ada pergerakan saldo wallet.
   - Response: `201 Created` dengan transaction id dan `pspRef`.

2. **A2. Handle PSP Callback (`POST /psp/callbacks`)**
   - Webhook payload: `{ "pspRef": "<ref>", "status": "completed"|"failed", "amount": "100.50" }`
   - Hostile Infrastructure Concerns:
     - **Idempotency (Sequential)**: Callback duplikat tidak boleh menambah saldo 2x.
     - **Concurrency (Parallel requests)**: Dua callback dengan `pspRef` sama yang tiba bersamaan harus ditangani secara aman (database row lock / unique constraint / distributed lock). Tepat 1 yang berhasil meng-credit.
     - **Amount mismatch handling**: Jika `amount` callback berbeda dengan deposit asli, tentukan kebijakan (misal: reject atau update berdasarkan business rule, dokumentasikan di `DECISIONS.md`).
     - **Unknown pspRef**: Return `404 Not Found` secara terukur.
   - Requirements:
     - Wallet dikredit **tepat 1 kali (exactly once)**.
     - Tulis append-only ledger (`wallet_txs` / transactions log) sehingga saldo selalu dapat direkonstruksi.
     - Funding transaction transisi status: `Pending -> Completed / Failed`. Tolak transisi invalid (state machine enforcement).

3. **A3. Record Wagers (`POST /wallets/:walletId/wagers`)**
   - Payload: `{ "amount": "10.00" }`
   - Action: Debit wallet (reject dengan `422/400` jika saldo tidak cukup).
   - Accrue turnover (menambah total turnover yang sudah dimainkan).
   - Concurrency: Dua wager bersamaan tidak boleh menyebabkan saldo negatif (overdraw protection menggunakan `SELECT ... FOR UPDATE` atau conditional update).
   - Tulis ledger entry.

4. **A4. Withdrawals with Turnover Lock (`POST /withdrawals`)**
   - Payload: `{ "memberId": "<uuid>", "amount": "50.00" }`
   - Business Rule (Anti-Abuse):
     - Setiap deposit yang selesai (`Completed`) menambah **turnover requirement** = `amount * turnoverMultiplier`.
     - Setiap wager menambah **accrued turnover** = `wager amount`.
     - Withdrawal HANYA diizinkan jika **accrued turnover >= total required turnover**.
     - Jika belum cukup: return `422 Unprocessable Entity` dengan rincian sisa turnover yang belum terpenuhi.
   - Jika valid: debit wallet seketika, catat ledger entry, dan buat funding transaction berstatus `Pending`.

5. **A5. Test Suite (Jest)**
   - Minimal Test Scenarios:
     - Duplicate callback (sequential) does not double-credit.
     - Concurrent duplicate callbacks do not double-credit.
     - Concurrent wagers cannot overdraw wallet.
     - Turnover lock blocks and unblocks withdrawal correctly.
     - Normal happy paths for deposit, wager, withdrawal.

---

### Part B: Design Note - The 50th PSP (`DESIGN-PSP.md`) (~45 min)
- Topik: *"How would you structure this codebase so that integrating a new PSP is a one-day task safely done by a junior engineer?"*
- Pembahasan:
  - Abstraction & Provider Interface (`PSPAdapter`).
  - Request/Webhook verification & payload normalization.
  - Configuration-driven architecture.
  - Testing strategy (Contract testing, Mock server, sandbox isolation).
- Format: Max ~1 page + sketch / diagram.

---

### Deliverables Checklist
- [ ] Codebase working under `src/` (models, migrations, services, routes).
- [ ] Comprehensive test suite under `test/`.
- [ ] `DECISIONS.md` (Design choices, concurrency locking strategy, assumptions, trade-offs, AI disclosure).
- [ ] `DESIGN-PSP.md` (Part B architecture write-up).
