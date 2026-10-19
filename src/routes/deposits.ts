import { Router } from 'express';
import { z } from 'zod';
import { createDeposit } from '../services/depositService';

export const depositsRouter = Router();

const createDepositSchema = z.object({
  memberId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal string'),
  turnoverMultiplier: z.number().int().min(0).optional(),
});

depositsRouter.post('/', async (req, res, next) => {
  const parsed = createDepositSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  try {
    const fundingTx = await createDeposit(parsed.data);
    return res.status(201).json({
      id: fundingTx.id,
      pspRef: fundingTx.pspRef,
      status: fundingTx.status,
      amount: fundingTx.amount,
      turnoverMultiplier: fundingTx.turnoverMultiplier,
    });
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});
