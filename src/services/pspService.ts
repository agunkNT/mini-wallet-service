import { sequelize } from '../db/sequelize';
import { Wallet, FundingTransaction, WalletTx } from '../db/models';
import { dec } from '../lib/money';

export interface PspCallbackParams {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
  rawPayload?: any;
}

export interface PspCallbackResult {
  message: string;
  fundingTxId: string;
  status: string;
  alreadyProcessed?: boolean;
}

export async function handlePspCallback(params: PspCallbackParams): Promise<PspCallbackResult> {
  const callbackAmount = dec(params.amount);

  return sequelize.transaction(async (t) => {
    // 1. Lock the funding transaction row to prevent race conditions on concurrent callbacks
    const fundingTx = await FundingTransaction.findOne({
      where: { pspRef: params.pspRef },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!fundingTx) {
      const err: any = new Error(`Funding transaction with pspRef ${params.pspRef} not found`);
      err.status = 404;
      throw err;
    }

    // 2. Idempotency Check: if already completed or failed, treat as idempotent success
    if (fundingTx.status !== 'pending') {
      return {
        message: `Callback already processed with status ${fundingTx.status}`,
        fundingTxId: fundingTx.id,
        status: fundingTx.status,
        alreadyProcessed: true,
      };
    }

    // 3. Amount verification: compare callback amount with funding transaction amount
    const expectedAmount = dec(fundingTx.amount);
    if (!callbackAmount.isEqualTo(expectedAmount)) {
      // Amount mismatch decision:
      // Mark as failed to prevent unverified money crediting and retain audit trace
      await fundingTx.update(
        {
          status: 'failed',
          rawCallbackPayload: {
            ...params.rawPayload,
            error: 'Amount mismatch',
            expected: expectedAmount.toFixed(18),
            received: callbackAmount.toFixed(18),
          },
        },
        { transaction: t },
      );

      return {
        message: `Callback amount mismatch: expected ${expectedAmount.toFixed(18)}, got ${callbackAmount.toFixed(18)}`,
        fundingTxId: fundingTx.id,
        status: 'failed',
      };
    }

    // 4. Handle failed callback
    if (params.status === 'failed') {
      await fundingTx.update(
        {
          status: 'failed',
          rawCallbackPayload: params.rawPayload || null,
        },
        { transaction: t },
      );

      return {
        message: 'Deposit marked as failed',
        fundingTxId: fundingTx.id,
        status: 'failed',
      };
    }

    // 5. Handle completed callback: Lock wallet and perform exactly-once credit
    const wallet = await Wallet.findByPk(fundingTx.walletId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!wallet) {
      const err: any = new Error(`Wallet ${fundingTx.walletId} not found`);
      err.status = 500;
      throw err;
    }

    const currentBalance = dec(wallet.balance);
    const newBalance = currentBalance.plus(expectedAmount);

    const currentRequiredTurnover = dec(wallet.requiredTurnover);
    const turnoverToAdd = expectedAmount.multipliedBy(fundingTx.turnoverMultiplier);
    const newRequiredTurnover = currentRequiredTurnover.plus(turnoverToAdd);

    // Update wallet balance and required turnover
    await wallet.update(
      {
        balance: newBalance.toFixed(18),
        requiredTurnover: newRequiredTurnover.toFixed(18),
      },
      { transaction: t },
    );

    // Insert append-only ledger transaction
    await WalletTx.create(
      {
        walletId: wallet.id,
        referenceId: fundingTx.id,
        referenceType: 'deposit',
        type: 'credit',
        amount: expectedAmount.toFixed(18),
        balanceBefore: currentBalance.toFixed(18),
        balanceAfter: newBalance.toFixed(18),
      },
      { transaction: t },
    );

    // Transition funding transaction status to completed
    await fundingTx.update(
      {
        status: 'completed',
        rawCallbackPayload: params.rawPayload || null,
      },
      { transaction: t },
    );

    return {
      message: 'Deposit completed and wallet credited',
      fundingTxId: fundingTx.id,
      status: 'completed',
    };
  });
}
