# DESIGN-PSP.md: Scaling to the 50th PSP

> **Challenge Prompt:**  
> *"How would you structure this codebase so that integrating a new PSP is a one-day task safely done by a junior engineer?"*

---

## 1. Architectural Vision: The Pluggable Provider Pattern

Scaling from 1 to 50+ Payment Service Providers (PSPs) without developer bottlenecks requires decoupling the **Core Money Engine** from **PSP-Specific Protocol Details**. 

A junior engineer must never modify core wallet logic, ledger logic, or transaction lock mechanisms. Instead, they should only implement a single, isolated adapter class adhering to a strict TypeScript contract (`PSPAdapter`).

```
              ┌─────────────────────────────────────────────────────────┐
              │                     Inbound Webhook                     │
              │                 POST /psp/:provider/callback            │
              └────────────────────────────┬────────────────────────────┘
                                           │
                                           ▼
              ┌─────────────────────────────────────────────────────────┐
              │            Dynamic PSP Gateway / Router                 │
              │  - Lookup provider adapter from ProviderRegistry        │
              │  - Verify Signature / HMAC (Provider specific)          │
              │  - Normalize payload into CanonicalNormalizedCallback   │
              └────────────────────────────┬────────────────────────────┘
                                           │
                                           ▼
              ┌─────────────────────────────────────────────────────────┐
              │             Core Transaction Engine (PspService)        │
              │  - Row-level locking (SELECT ... FOR UPDATE)            │
              │  - Idempotency guard (Status transition validation)     │
              │  - Exactly-once Wallet Crediting + Append-Only Ledger   │
              └─────────────────────────────────────────────────────────┘
```

---

## 2. Standardized Interface Contract (`PSPAdapter`)

Every provider conforms to a well-typed interface:

```typescript
export interface CanonicalNormalizedCallback {
  pspRef: string;
  status: 'completed' | 'failed' | 'pending';
  amount: string; // Decimal string, standardized to major units (e.g. "100.50")
  currency: string;
  externalTransactionId: string;
  rawPayload: Record<string, unknown>;
}

export interface PSPAdapter {
  readonly providerId: string;

  /**
   * Cryptographically verifies inbound webhook signature or token.
   */
  verifySignature(headers: Record<string, string>, rawBody: Buffer | string): boolean;

  /**
   * Converts provider quirks (cents/minor units, camelCase vs snake_case,
   * custom status words like "SUCCESS", "PAID", "CHARGED") into unified format.
   */
  normalizeCallback(headers: Record<string, string>, body: any): CanonicalNormalizedCallback;

  /**
   * Initiates payment with external gateway (if server-to-server checkout).
   */
  createPayment(intent: PaymentIntent): Promise<PaymentInitiationResult>;
}
```

---

## 3. How a Junior Engineer Integrates a New PSP in One Day

To onboard PSP #50 (e.g. `Xendit` or `Stripe`):

1. **Create Adapter File**:
   - Create `src/psp/providers/xendit/xenditAdapter.ts` implementing `PSPAdapter`.
   - Write pure transformation logic:
     ```typescript
     export class XenditAdapter implements PSPAdapter {
       readonly providerId = 'xendit';
       verifySignature(headers, rawBody) {
         return crypto.timingSafeEqual(...);
       }
       normalizeCallback(headers, body) {
         return {
           pspRef: body.external_id,
           status: body.status === 'PAID' ? 'completed' : 'failed',
           amount: dec(body.paid_amount).toFixed(18), // Handles minor/major unit normalization
           currency: body.currency,
           externalTransactionId: body.id,
           rawPayload: body,
         };
       }
     }
     ```
2. **Register Provider in Configuration**:
   - Register the adapter in `src/psp/registry.ts`:
     ```typescript
     PSPRegistry.register('xendit', new XenditAdapter(config.xendit));
     ```
3. **Automatic Routing & Execution**:
   - Endpoint: `POST /psp/:provider/callback`.
   - The router resolves `PSPRegistry.get(req.params.provider)`, invokes `verifySignature()` and `normalizeCallback()`, and hands off the canonical result to `pspService.handleCallback()`.
   - **Safety Guarantee**: The junior engineer touches **zero database transactions, zero locking code, and zero wallet tables**.

---

## 4. Configuration-Driven Architecture

Instead of hardcoding environment values across code:
- Each PSP configuration is declared via a typed schema (e.g. Zod):
  ```typescript
  const ProviderConfigSchema = z.object({
    enabled: z.boolean(),
    apiKey: z.string(),
    webhookSecret: z.string(),
    sandboxUrl: z.string().url().optional(),
    amountUnit: z.enum(['major', 'minor_cents']), // 100 vs 10000
  });
  ```
- Adding a new region or brand simply toggles JSON/env configurations without modifying backend code.

---

## 5. Testing Strategy in CI Without Live PSP Access

Because real PSP sandboxes are flaky, rate-limited, or inaccessible in isolated CI pipelines:

1. **Adapter Golden Contract Tests**:
   - Every provider directory includes `fixtures/callback_success.json`, `fixtures/callback_failed.json`, and `fixtures/headers.json`.
   - A standardized contract test verifies that `normalizeCallback()` maps these fixtures accurately into `CanonicalNormalizedCallback`.
2. **Mock PSP Server (WireMock / Express Mock)**:
   - Run a lightweight mock server in docker-compose during integration testing to simulate provider retry behavior, webhook latency, and network timeouts.
3. **Fuzzing & Hostile Delivery Tests**:
   - Replay captured payloads in parallel to guarantee that even if the new PSP sends duplicate callbacks out of order, the core idempotency guard never breaks.
