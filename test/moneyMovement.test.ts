import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';
import { dec } from '../src/lib/money';

const app = createApp();

describe('Money Movement & Concurrency Test Suite (A1 - A5)', () => {
  beforeEach(async () => {
    await WalletTx.destroy({ where: {}, force: true });
    await FundingTransaction.destroy({ where: {}, force: true });
    await Wallet.destroy({ where: {}, force: true });
    await Member.destroy({ where: {}, force: true });
  });

  // DB cleanup


  async function createTestMember(username: string) {
    const res = await request(app).post('/members').send({ username });
    expect(res.status).toBe(201);
    return res.body;
  }

  describe('A1: Create Deposit (POST /deposits)', () => {
    it('creates a pending funding transaction with pspRef', async () => {
      const { member } = await createTestMember('alice');

      const res = await request(app)
        .post('/deposits')
        .send({
          memberId: member.id,
          amount: '100.50',
          turnoverMultiplier: 2,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.pspRef).toMatch(/^psp_dep_/);
      expect(res.body.status).toBe('pending');
      expect(dec(res.body.amount).toFixed(2)).toBe('100.50');
      expect(res.body.turnoverMultiplier).toBe(2);

      // Verify DB record
      const fundingTx = await FundingTransaction.findByPk(res.body.id);
      expect(fundingTx).not.toBeNull();
      expect(fundingTx!.status).toBe('pending');

      // Verify wallet balance is NOT changed yet
      const wallet = await Wallet.findOne({ where: { memberId: member.id } });
      expect(dec(wallet!.balance).toFixed(2)).toBe('0.00');
    });

    it('rejects non-positive deposit amount', async () => {
      const { member } = await createTestMember('bob');

      const res = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '-10.00' });

      expect(res.status).toBe(400);
    });
  });

  describe('A2 & A5: Handle PSP Callback (Idempotency & Concurrency)', () => {
    it('credits wallet exactly once on duplicate sequential callback', async () => {
      const { member, wallet } = await createTestMember('carol');

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 1 });
      const { pspRef } = depRes.body;

      // 1st Callback: Success
      const res1 = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef, status: 'completed', amount: '100.00' });
      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('completed');
      expect(res1.body.alreadyProcessed).toBeFalsy();

      // 2nd Callback: Duplicate retry
      const res2 = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef, status: 'completed', amount: '100.00' });
      expect(res2.status).toBe(200);
      expect(res2.body.alreadyProcessed).toBe(true);

      // Verify wallet balance is 100.00 (NOT 200.00)
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(dec(updatedWallet!.balance).toFixed(2)).toBe('100.00');
      expect(dec(updatedWallet!.requiredTurnover).toFixed(2)).toBe('100.00');

      // Verify ledger has exactly 1 credit entry
      const txs = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(txs.length).toBe(1);
      expect(txs[0].type).toBe('credit');
      expect(dec(txs[0].amount).toFixed(2)).toBe('100.00');
    });

    it('credits wallet exactly once under high concurrent callbacks', async () => {
      const { member, wallet } = await createTestMember('dave');

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '500.00', turnoverMultiplier: 1 });
      const { pspRef } = depRes.body;

      // Fire 10 parallel identical callbacks simultaneously
      const parallelRequests = Array.from({ length: 10 }, () =>
        request(app)
          .post('/psp/callbacks')
          .send({ pspRef, status: 'completed', amount: '500.00' }),
      );

      const responses = await Promise.all(parallelRequests);
      responses.forEach((r) => expect(r.status).toBe(200));

      // Wallet balance must be exactly 500.00
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(dec(updatedWallet!.balance).toFixed(2)).toBe('500.00');

      // Exactly 1 ledger row written
      const txs = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(txs.length).toBe(1);
      expect(dec(txs[0].amount).toFixed(2)).toBe('500.00');

      // Exactly 1 request executed fresh crediting, 9 detected alreadyProcessed
      const freshCredits = responses.filter((r) => !r.body.alreadyProcessed);
      const idempotentReturns = responses.filter((r) => r.body.alreadyProcessed);
      expect(freshCredits.length).toBe(1);
      expect(idempotentReturns.length).toBe(9);
    });

    it('rejects callback with amount mismatch and preserves integrity', async () => {
      const { member, wallet } = await createTestMember('eve');

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00' });
      const { pspRef } = depRes.body;

      // Provider sends 50.00 instead of 100.00
      const res = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef, status: 'completed', amount: '50.00' });

      expect(res.status).toBe(400);

      // Wallet balance remains 0
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(dec(updatedWallet!.balance).toFixed(2)).toBe('0.00');

      // Funding transaction marked failed
      const tx = await FundingTransaction.findOne({ where: { pspRef } });
      expect(tx!.status).toBe('failed');
    });

    it('returns 404 for unknown pspRef', async () => {
      const res = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: 'psp_dep_unknown_123', status: 'completed', amount: '10.00' });

      expect(res.status).toBe(404);
    });
  });

  describe('A3 & A5: Wagers (Concurrency & Overdraw Protection)', () => {
    it('debits wallet and accrues turnover on wager', async () => {
      const { member, wallet } = await createTestMember('frank');

      // Fund wallet with 100
      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 1 });
      await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '100.00' });

      // Place wager of 30.00
      const res = await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '30.00' });

      expect(res.status).toBe(200);
      expect(dec(res.body.balance).toFixed(2)).toBe('70.00');
      expect(dec(res.body.accruedTurnover).toFixed(2)).toBe('30.00');

      // Ledger check
      const txs = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(txs.length).toBe(2); // 1 credit (deposit), 1 debit (wager)
    });

    it('prevents overdraw when concurrent wagers exceed balance', async () => {
      const { member, wallet } = await createTestMember('grace');

      // Fund wallet with 100.00
      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 1 });
      await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '100.00' });

      // Attempt 5 simultaneous wagers of 30.00 each (Total = 150.00, but balance is only 100.00)
      // Exactly 3 wagers can succeed (3 x 30 = 90), 2 must fail with 422
      const wagerRequests = Array.from({ length: 5 }, () =>
        request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '30.00' }),
      );

      const responses = await Promise.all(wagerRequests);
      const successful = responses.filter((r) => r.status === 200);
      const failed = responses.filter((r) => r.status === 422);

      expect(successful.length).toBe(3);
      expect(failed.length).toBe(2);

      // Final balance must be 10.00, NEVER negative
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(dec(updatedWallet!.balance).toFixed(2)).toBe('10.00');
      expect(dec(updatedWallet!.accruedTurnover).toFixed(2)).toBe('90.00');
    });
  });

  describe('A4 & A5: Withdrawals with Turnover Lock', () => {
    it('blocks withdrawal when turnover requirement is not met (422)', async () => {
      const { member, wallet } = await createTestMember('heidi');

      // Deposit 100.00 with multiplier 2 -> Required Turnover = 200.00
      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 2 });
      await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '100.00' });

      // Only wager 50.00 -> Accrued = 50.00, Outstanding = 150.00
      await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '50.00' });

      // Try withdrawal
      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '20.00' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Turnover requirement not met');
      expect(res.body.requiredTurnover).toBe('200.00');
      expect(res.body.accruedTurnover).toBe('50.00');
      expect(res.body.outstandingTurnover).toBe('150.00');

      // Balance must NOT be debited
      const checkWallet = await Wallet.findByPk(wallet.id);
      expect(dec(checkWallet!.balance).toFixed(2)).toBe('50.00');
    });

    it('unblocks withdrawal once accrued turnover >= required turnover', async () => {
      const { member, wallet } = await createTestMember('ivan');

      // Deposit 50.00 with multiplier 1 -> Required Turnover = 50.00
      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '50.00', turnoverMultiplier: 1 });
      await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '50.00' });

      // Accrue 50.00 turnover through wagers
      await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '25.00' });
      await request(app).post(`/wallets/${wallet.id}/wagers`).send({ amount: '25.00' });

      // Fund more without turnover requirement (multiplier 0) so we have balance to withdraw
      const dep2 = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 0 });
      await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: dep2.body.pspRef, status: 'completed', amount: '100.00' });

      // Current balance = 100.00. Required turnover = 50.00, Accrued = 50.00.
      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '60.00' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('pending');
      expect(dec(res.body.remainingBalance).toFixed(2)).toBe('40.00');

      // Verify wallet balance is debited
      const finalWallet = await Wallet.findByPk(wallet.id);
      expect(dec(finalWallet!.balance).toFixed(2)).toBe('40.00');

      // Verify ledger transaction created
      const withdrawalTx = await WalletTx.findOne({
        where: { walletId: wallet.id, referenceType: 'withdrawal' },
      });
      expect(withdrawalTx).not.toBeNull();
      expect(withdrawalTx!.type).toBe('debit');
      expect(dec(withdrawalTx!.amount).toFixed(2)).toBe('60.00');
    });

    it('rejects withdrawal if balance is insufficient', async () => {
      const { member } = await createTestMember('judy');

      // Zero balance
      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '50.00' });

      expect(res.status).toBe(422);
    });
  });
});
