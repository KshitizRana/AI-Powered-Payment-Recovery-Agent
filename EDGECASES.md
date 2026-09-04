# Edge Cases

| Scenario | Handling |
|---|---|
| Same webhook delivered twice | `processed_webhooks` unique constraint, insert-then-catch on a `23505` conflict |
| Two failure events for the same subscription in quick succession | Inngest `idempotency` keyed on `subscriptionId` |
| Two failure events for the same subscription across the full 7-day cascade | DB-level check for an existing active recovery attempt before creating a new one — Inngest's idempotency window doesn't cover a full multi-day cascade on its own |
| Customer pays mid-cascade, but the reactivation webhook is dropped or delayed | Every escalation step independently re-polls Razorpay's actual subscription/order status before acting, rather than trusting only the webhook |
| Customer pays mid-cascade, webhook arrives fine | `cancelOn` cancels the running function immediately instead of waiting for the next scheduled poll |
| OpenAI is unreachable or returns a schema-invalid response | Rule-based fallback for all four AI functions, same hard guarantees (time cutoff, DND, guardrails) preserved regardless of which path produced the decision |
| Customer has opted out | Guardrail blocks before any contact, regardless of what the AI would have recommended |
| Payment/checkout amount too small to be worth pursuing | Guardrail blocks before any AI call |
| High-value payment never recovers after all escalation steps | Ends as `escalated`, not `abandoned` — a signal for human follow-up rather than a silent write-off |
| Checkout abandoned but customer completes it during the cooldown window | Self-detected on re-check, marked recovered without ever sending a message |
| Malformed webhook payload | Shape-checked on `event`/`payload` presence, returns 400 before touching the database |
| Razorpay API call hangs | 10-second timeout wrapper on every outbound Razorpay call |
| Checkout abandonment event carried no `customerId` | The webhook handler for standalone checkout failures didn't look up or attach a customer record, so the DND guardrail had nothing to check against and silently passed every checkout through untouched. Fixed by calling the same customer upsert the subscription-failure path already used. |
| A checkout blocked by a guardrail left no trace in the database | The guardrail check originally ran before the recovery record was created, so a blocked-at-the-door checkout produced zero rows anywhere — invisible to the dashboard and the audit trail alike. Reordered so the record (and an initial audit entry) always exists first; a guardrail block now writes an `abandoned` status with the reason, instead of vanishing silently. |
| AI recommends a channel the customer has no contact info for | The action record was written as `status: "sent"` unconditionally, before the send was even attempted — so a failed or skipped send would misreport as successful in the audit trail. Changed to insert as `pending` and update to `sent`/`failed` based on the actual delivery result. |
| Compressed test/demo timing collides with the contact-gap guardrail | Shrinking the cascade's wait time for local testing doesn't shrink the guardrail's hour-based cooldown, so a fast test run could self-block two or three steps in purely as an artifact of test speed, not a real compliance concern. A `FAST_DEMO_MODE` flag relaxes the cooldown specifically for this case, off by default. |
| Dashboard's notification count silently undercounted | Simulated SMS/WhatsApp sends are inserted with `status: "queued"`, but the metrics endpoint only counted `status = "sent"` — so every non-email send was invisible in the headline notification total. Widened the count to include `queued` alongside `sent`/`delivered`. |