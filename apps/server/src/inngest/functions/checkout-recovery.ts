import { inngest } from "../client";
import { db, recoveryAttempts, recoveryActions, auditLogs, eq } from "@repo/db";
import { fetchOrder, createPaymentLink } from "../../services/razorpay.service";
import { classifyAbandonment, generateRecoveryMessage, deriveDisplayName } from "../../services/ai.service";
import { runPreActionGuardrails } from "../../lib/guardrails";
import { sendNotification } from "../../services/notification.service";
import { RECOVERY_CONFIG } from "@repo/shared";

export const checkoutRecovery = inngest.createFunction(
    {
        id: "checkout-recovery",
        concurrency: { limit: 15 },
        idempotency: "event.data.orderId",
        cancelOn: [
            {
                event: "payment/checkout.completed",
                if: "async.data.orderId == event.data.orderId",
            },
        ],
        triggers: [{ event: "payment/checkout.abandoned" },]
    },

    async ({ event, step }) => {
        const { orderId, customerEmail, customerPhone, amount, currency, method, abandonedAt } = event.data;

        // ── Guardrail: not worth recovering ──
        const guardrailCheck = await step.run("guardrail-amount", async () => {
            return await runPreActionGuardrails({ amountPaise: amount });
        });

        if (!guardrailCheck.allowed) {
            return { status: "skipped", reason: guardrailCheck.reason };
        }

        // ── Create the recovery record ──
        const recovery = await step.run("create-recovery-record", async () => {
            const [record] = await db.insert(recoveryAttempts).values({
                type: "checkout_abandonment",
                razorpayEntityId: orderId,
                status: "detected",
                failureCategory: "checkout_abandoned",
                amountAtRisk: amount,
                currency: currency || "INR",
                metadata: { customerEmail, customerPhone },
                maxSteps: 2,
            }).returning();

            if (!record) {
                throw new Error("Failed to create recovery attempt record");
            }
            return record;
        });

        await step.run("audit-detected", async () => {
            await db.insert(auditLogs).values({
                recoveryAttemptId: recovery.id,
                eventType: "recovery.detected",
                actor: "system",
                action: `Checkout abandonment detected for order ${orderId}`,
                details: { event: event.data },
            });
        });

        // ── Debounce: don't chase someone who's still mid-checkout ──
        await step.sleep("cooldown", `${RECOVERY_CONFIG.CHECKOUT_ABANDON_COOLDOWN_MINUTES}m`);

        // ── Re-check: did they actually complete it during the cooldown? ──
        const stillAbandoned = await step.run("recheck-order-status", async () => {
            const order = await fetchOrder(orderId);
            return order.status !== "paid";
        });

        if (!stillAbandoned) {
            await step.run("mark-recovered-self", async () => {
                await db.update(recoveryAttempts)
                    .set({ status: "recovered", amountRecovered: amount, recoveredAt: new Date() })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: "recovery.completed",
                    actor: "system",
                    action: `Order ${orderId} was paid during the cooldown window — no intervention needed.`,
                });
            });
            return { status: "recovered", step: 0, amount };
        }

        // ── TTL: don't chase a checkout that's genuinely stale ──
        const ageHours = (Date.now() - new Date(abandonedAt).getTime()) / (1000 * 60 * 60);
        if (ageHours > RECOVERY_CONFIG.CHECKOUT_MAX_AGE_HOURS) {
            await step.run("mark-expired", async () => {
                await db.update(recoveryAttempts)
                    .set({ status: "abandoned", abandonedAt: new Date() })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: "recovery.expired",
                    actor: "system",
                    action: `Checkout is ${ageHours.toFixed(1)}h old — past the ${RECOVERY_CONFIG.CHECKOUT_MAX_AGE_HOURS}h recovery window.`,
                });
            });
            return { status: "expired", ageHours };
        }

        // ── AI: why did they leave? ──
        const classification = await step.run("classify-abandonment", async () => {
            return await classifyAbandonment({ amount, currency: currency || "INR", method });
        });

        // ── First message ──
        if (customerEmail) {
            await step.run("send-first-message", async () => {
                const message = await generateRecoveryMessage({
                    customerName: deriveDisplayName(customerEmail),
                    amount,
                    currency: currency || "INR",
                    failureCategory: "checkout_abandoned",
                    escalationStep: 1,
                    maxSteps: 2,
                    channel: "email",
                    productDescription: "your recent checkout",
                });

                const link = await createPaymentLink({
                    amount,
                    currency: currency || "INR",
                    customerName: deriveDisplayName(customerEmail),
                    customerEmail: customerEmail,
                    customerPhone: customerPhone,
                    description: "Complete your checkout",
                    expireBy: Math.floor(Date.now() / 1000) + 24 * 3600, // 24h expiry
                });

                const [action] = await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: 1,
                    actionType: "send_email",
                    status: "pending",
                    aiReasoning: `${classification.reasoning} (tone: ${classification.suggestedTone})`,
                    channel: "email",
                    messageContent: message.body,
                    paymentLinkId: link.id,
                    paymentLinkUrl: link.short_url,
                }).returning();

                if (!action) {
                    throw new Error("Failed to create recovery action");
                }

                const result = await sendNotification("email", {
                    to: customerEmail,
                    subject: message.subject,
                    body: message.body,
                    customerName: deriveDisplayName(customerEmail),
                    actionUrl: link.short_url,
                    actionText: message.callToAction,
                    tone: message.tone as any,
                    recoveryAttemptId: recovery.id,
                    recoveryActionId: action.id,
                });

                await db.update(recoveryActions)
                    .set({ status: result.success ? "sent" : "failed" })
                    .where(eq(recoveryActions.id, action.id));

                await db.update(recoveryAttempts)
                    .set({ status: "intervention_sent", currentStep: 1 })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: "recovery.escalation.step-1",
                    actor: "ai",
                    action: `Sent checkout recovery email (reason: ${classification.reason}, tone: ${classification.suggestedTone})`,
                    details: { classification, delivered: result.success },
                });
            });
        }

        // ── AI-recommended follow-up window ──
        const followUpMinutes = Math.max(classification.recommendedFollowUpMinutes, 10);
        await step.sleep("wait-follow-up", "15s"); // 🔥 HARDCODED FOR DEMO/TESTING (was `${followUpMinutes}m`)

        const stillAbandonedAfterFollowUp = await step.run("recheck-order-status-2", async () => {
            const order = await fetchOrder(orderId);
            return order.status !== "paid";
        });

        if (!stillAbandonedAfterFollowUp) {
            await step.run("mark-recovered-after-message", async () => {
                await db.update(recoveryAttempts)
                    .set({ status: "recovered", amountRecovered: amount, recoveredAt: new Date() })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: "recovery.completed",
                    actor: "system",
                    action: `Order ${orderId} paid after the recovery email. ₹${amount / 100} recovered.`,
                });
            });
            return { status: "recovered", step: 1, amount };
        }

        // ── One lighter second nudge, then stop — checkouts don't get a 5-step cascade ──
        if (customerEmail) {
            await step.run("send-final-nudge", async () => {
                const message = await generateRecoveryMessage({
                    customerName: deriveDisplayName(customerEmail),
                    amount,
                    currency: currency || "INR",
                    failureCategory: "checkout_abandoned",
                    escalationStep: 3, // borrow the "more urgent" tone bracket
                    maxSteps: 3, // so progress is 3/3 = 100% (urgent tone)
                    channel: "email",
                    productDescription: "your recent checkout",
                });

                const link = await createPaymentLink({
                    amount,
                    currency: currency || "INR",
                    customerName: deriveDisplayName(customerEmail),
                    customerEmail: customerEmail,
                    customerPhone: customerPhone,
                    description: "Complete your checkout",
                    expireBy: Math.floor(Date.now() / 1000) + 12 * 3600, // 12h expiry
                });

                const [action] = await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: 2,
                    actionType: "send_email",
                    status: "pending",
                    aiReasoning: "Final nudge before giving up on this checkout.",
                    channel: "email",
                    messageContent: message.body,
                    paymentLinkId: link.id,
                    paymentLinkUrl: link.short_url,
                }).returning();

                if (!action) {
                    throw new Error("Failed to create recovery action");
                }

                const result = await sendNotification("email", {
                    to: customerEmail,
                    subject: message.subject,
                    body: message.body,
                    customerName: deriveDisplayName(customerEmail),
                    actionUrl: link.short_url,
                    actionText: message.callToAction,
                    tone: message.tone as any,
                    recoveryAttemptId: recovery.id,
                    recoveryActionId: action.id,
                });

                await db.update(recoveryActions)
                    .set({ status: result.success ? "sent" : "failed" })
                    .where(eq(recoveryActions.id, action.id));
            });
        }

        await step.run("finalize-abandoned", async () => {
            await db.update(recoveryAttempts)
                .set({ status: "abandoned", currentStep: 2, abandonedAt: new Date() })
                .where(eq(recoveryAttempts.id, recovery.id));

            await db.insert(auditLogs).values({
                recoveryAttemptId: recovery.id,
                eventType: "recovery.abandoned",
                actor: "system",
                action: "Both recovery messages sent, order still unpaid. Marked abandoned.",
            });
        });

        return { status: "abandoned", amount };
    }
);