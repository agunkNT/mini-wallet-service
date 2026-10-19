import { Router } from 'express';
import { z } from 'zod';
import { handlePspCallback } from '../services/pspService';

export const pspRouter = Router();

const pspCallbackSchema = z.object({
  pspRef: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Amount must be a positive decimal string'),
});

pspRouter.post('/callbacks', async (req, res, next) => {
  const parsed = pspCallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues });
  }

  try {
    const result = await handlePspCallback({
      ...parsed.data,
      rawPayload: req.body,
    });
    if (result.status === 'failed' && result.message.includes('mismatch')) {
      return res.status(400).json(result);
    }
    return res.status(200).json(result);
  } catch (err: any) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});
