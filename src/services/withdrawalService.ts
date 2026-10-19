import crypto from 'crypto';
import { sequelize } from '../db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../db/models';
import { dec, ZERO } from '../lib/money';

export interface CreateWithdrawalParams {
  memberId: string;
  amount: string;
}

export interface WithdrawalResult {
  fundingTx: FundingTransaction;
  remainingBalance: string;
}

export async function createWithdrawal(params: CreateWithdrawalParams): Promise<WithdrawalResult> {
  const withdrawalAmount = dec(params.amount);
  if (withdrawalAmount.lte(0)) {
    const err: any = new Error('Withdrawal amount must be positive');
    err.status = 400;
    throw err;
  }

  return sequelize.transaction(async (t) => {
    // 1. Verify Member
    const member = await Member.findByPk(params.memberId, { transaction: t });
    if (!member) {
      const err: any = new Error('Member not found');
      err.status = 404;
      throw err;
    }

    // 2. Lock member's wallet row FOR UPDATE
    const wallet = await Wallet.findOne({
      where: { memberId: member.id },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!wallet) {
      const err: any = new Error('Wallet not found');
      err.status = 404;
      throw err;
    }

    // 3. Turnover lock check (Anti-abuse control)
    const required = dec(wallet.requiredTurnover);
    const accrued = dec(wallet.accruedTurnover);
    const outstandingTurnover = required.minus(accrued);

    if (outstandingTurnover.gt(0)) {
      const err: any = new Error('Turnover requirement not met');
      err.status = 422;
      err.data = {
        error: 'Turnover requirement not met',
        requiredTurnover: required.toFixed(2),
        accruedTurnover: accrued.toFixed(2),
        outstandingTurnover: outstandingTurnover.toFixed(2),
      };
      throw err;
    }

    // 4. Balance check
    const currentBalance = dec(wallet.balance);
    if (currentBalance.lt(withdrawalAmount)) {
      const err: any = new Error('Insufficient wallet balance for withdrawal');
      err.status = 422;
      throw err;
    }

    // 5. Debit wallet immediately
    const newBalance = currentBalance.minus(withdrawalAmount);
    await wallet.update(
      {
        balance: newBalance.toFixed(18),
      },
      { transaction: t },
    );

    // 6. Generate reference & Create pending funding transaction
    const pspRef = `psp_wdr_${crypto.randomBytes(16).toString('hex')}`;
    const fundingTx = await FundingTransaction.create(
      {
        memberId: member.id,
        walletId: wallet.id,
        type: 'withdrawal',
        amount: withdrawalAmount.toFixed(18),
        turnoverMultiplier: 0,
        status: 'pending',
        pspRef,
      },
      { transaction: t },
    );

    // 7. Write append-only ledger transaction
    await WalletTx.create(
      {
        walletId: wallet.id,
        referenceId: fundingTx.id,
        referenceType: 'withdrawal',
        type: 'debit',
        amount: withdrawalAmount.toFixed(18),
        balanceBefore: currentBalance.toFixed(18),
        balanceAfter: newBalance.toFixed(18),
      },
      { transaction: t },
    );

    return {
      fundingTx,
      remainingBalance: newBalance.toFixed(18),
    };
  });
}
