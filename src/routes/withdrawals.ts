import { Router } from 'express';
import { z } from 'zod';
import { createWithdrawal } from '../services/withdrawalService';

export const withdrawalsRouter = Router();

const createWithdrawalSchema = z.object({
  memberId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal string'),
});

withdrawalsRouter.post('/', async (req, res, next) => {
  const parsed = createWithdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  try {
    const result = await createWithdrawal(parsed.data);
    return res.status(201).json({
      id: result.fundingTx.id,
      pspRef: result.fundingTx.pspRef,
      status: result.fundingTx.status,
      amount: result.fundingTx.amount,
      remainingBalance: result.remainingBalance,
    });
  } catch (err: any) {
    if (err.status) {
      if (err.data) {
        return res.status(err.status).json(err.data);
      }
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});
