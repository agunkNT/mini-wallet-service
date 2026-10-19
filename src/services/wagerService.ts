import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { dec } from '../lib/money';

export interface RecordWagerParams {
  walletId: string;
  amount: string;
}

export interface WagerResult {
  walletId: string;
  balance: string;
  accruedTurnover: string;
}

export async function recordWager(params: RecordWagerParams): Promise<WagerResult> {
  const wagerAmount = dec(params.amount);
  if (wagerAmount.lte(0)) {
    const err: any = new Error('Wager amount must be positive');
    err.status = 400;
    throw err;
  }

  return sequelize.transaction(async (t) => {
    // 1. Lock wallet row FOR UPDATE to prevent race conditions & overdraws
    const wallet = await Wallet.findByPk(params.walletId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!wallet) {
      const err: any = new Error('Wallet not found');
      err.status = 404;
      throw err;
    }

    const currentBalance = dec(wallet.balance);
    if (currentBalance.lt(wagerAmount)) {
      const err: any = new Error('Insufficient wallet balance for wager');
      err.status = 422;
      throw err;
    }

    const newBalance = currentBalance.minus(wagerAmount);
    const currentAccrued = dec(wallet.accruedTurnover);
    const newAccrued = currentAccrued.plus(wagerAmount);

    // Update wallet
    await wallet.update(
      {
        balance: newBalance.toFixed(18),
        accruedTurnover: newAccrued.toFixed(18),
      },
      { transaction: t },
    );

    // Write append-only ledger
    await WalletTx.create(
      {
        walletId: wallet.id,
        referenceId: null,
        referenceType: 'wager',
        type: 'debit',
        amount: wagerAmount.toFixed(18),
        balanceBefore: currentBalance.toFixed(18),
        balanceAfter: newBalance.toFixed(18),
      },
      { transaction: t },
    );

    return {
      walletId: wallet.id,
      balance: newBalance.toFixed(18),
      accruedTurnover: newAccrued.toFixed(18),
    };
  });
}
