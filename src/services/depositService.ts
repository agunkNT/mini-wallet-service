import crypto from 'crypto';
import { sequelize } from '../db/sequelize';
import { Member, Wallet, FundingTransaction } from '../db/models';
import { dec } from '../lib/money';

export interface CreateDepositParams {
  memberId: string;
  amount: string;
  turnoverMultiplier?: number;
}

export async function createDeposit(params: CreateDepositParams): Promise<FundingTransaction> {
  const depositAmount = dec(params.amount);
  if (depositAmount.lte(0)) {
    throw new Error('Deposit amount must be positive');
  }

  const turnoverMultiplier = params.turnoverMultiplier !== undefined ? params.turnoverMultiplier : 1;
  if (turnoverMultiplier < 0 || !Number.isInteger(turnoverMultiplier)) {
    throw new Error('turnoverMultiplier must be an integer >= 0');
  }

  return sequelize.transaction(async (t) => {
    const member = await Member.findByPk(params.memberId, { transaction: t });
    if (!member) {
      const err: any = new Error('Member not found');
      err.status = 404;
      throw err;
    }

    const wallet = await Wallet.findOne({ where: { memberId: member.id }, transaction: t });
    if (!wallet) {
      const err: any = new Error('Wallet not found');
      err.status = 404;
      throw err;
    }

    const pspRef = `psp_dep_${crypto.randomBytes(16).toString('hex')}`;

    const fundingTx = await FundingTransaction.create(
      {
        memberId: member.id,
        walletId: wallet.id,
        type: 'deposit',
        amount: depositAmount.toFixed(18),
        turnoverMultiplier,
        status: 'pending',
        pspRef,
      },
      { transaction: t },
    );

    return fundingTx;
  });
}
