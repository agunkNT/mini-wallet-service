import { Router } from 'express';
import { z } from 'zod';
import { recordWager } from '../services/wagerService';

export const walletsRouter = Router();

const recordWagerSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal string'),
});

walletsRouter.post('/:walletId/wagers', async (req, res, next) => {
  const { walletId } = req.params;
  const parsed = recordWagerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  try {
    const result = await recordWager({
      walletId,
      amount: parsed.data.amount,
    });
    return res.status(200).json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});
