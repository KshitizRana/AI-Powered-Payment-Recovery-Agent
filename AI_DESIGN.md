# AI Design

## Four AI functions, four jobs

1. **`diagnoseFailure`**: categorizes *why* a subscription payment failed (soft decline / hard decline / gateway error) and recommends an initial action. Runs once, at the start of a subscription recovery.
2. **`classifyAbandonment`**: the checkout-side equivalent of `diagnoseFailure`. Infers a likely reason for cart/checkout abandonment (price hesitation, payment friction, technical issue) from the available signals, and recommends a tone and follow-up window.
3. **`determineNextAction`**: runs at every step of the subscription escalation cascade. Decides action + channel + whether to stop, given the failure category, how many steps have already run, and what's already been tried.
4. **`generateRecoveryMessage`**: writes the actual outbound message copy for either flow, tone matched to how far into the cascade this step is.

## What the AI decides vs. what's hard-coded

The AI does **not** decide:
- Whether an opted-out customer gets contacted; checked by a guardrail before the AI is ever called
- Whether an amount below the recovery threshold gets pursued; same, a guardrail check, not a model judgment
- The cascade's timing skeleton - Day 0 → 1 → 3 → 5 → 7 is a fixed schedule, not AI-timed
- The 7-day recovery window cutoff - enforced twice: once as guidance in the prompt, once as a hard-coded override in `determineNextAction`'s own logic that fires even if the model's output ignores the prompt

The AI **does** decide:
- Which of 7 defined actions fits this specific situation (`retry_payment` / `send_payment_link` / `send_email` / `send_sms` / `send_whatsapp` / `escalate` / `no_action`)
- Which channel to use with an explicit "don't repeat the immediately previous channel" instruction, and a customer's known channel preference factored in when available
- The actual message content and tone
- Whether to stop the cascade early - e.g., a low-value payment where continued contact stops being worth it, independent of the fixed day schedule

## Fallback behavior

Every AI call is wrapped in a try/catch - if OpenAI is unreachable, or returns something that fails schema validation, a rule-based fallback (`fallbackDiagnosis`, `fallbackNextAction`, `fallbackMessage`) takes over with the same function signature and the same hard guarantees: the 7-day cutoff and DND/guardrail checks still apply regardless of which path produced the decision. An OpenAI outage degrades personalization, not correctness - the workflow never crashes because the model was unavailable.

## Guardrails (checked before every action, on every escalation step - not just once at the start)

1. **Amount threshold**: below `MIN_RECOVERY_AMOUNT_PAISE`, blocked before any AI call happens. Cheapest check, runs first, no DB round-trip required.
2. **Opt-out (DND)**: `customers.optedOut`, checked on every action, not cached from an earlier check.
3. **Contact-gap cooldown**: a minimum number of hours must have passed since `customers.lastContactedAt` before another contact is allowed, so the cascade's own steps can never fire closer together than the cooldown permits. (An earlier design tracked a rolling count of contacts per time window instead; the cooldown replaced it as a simpler mechanism that closes the same compliance gap with less state to reason about.)
4. **Recovery window**: a hard cutoff on total days since detection, enforced independent of what the AI recommends, so nothing runs indefinitely even if every other guardrail is somehow satisfied.

## A note on model choice

`classifyAbandonment` intentionally runs on a smaller/cheaper model than the other three functions   checkout-abandonment reasoning doesn't need the same reasoning depth as multi-step escalation decisions, and using a lighter model for a lower-stakes classification task is a deliberate cost/quality trade-off, not an oversight.