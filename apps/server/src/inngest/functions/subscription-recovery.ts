import { inngest } from "../client";
import { MAX_CONCURRENT_RECOVERIES, HARD_DECLINE_WAIT_TIME, DEFAULT_CURRENCY, ESCALATION_WAIT_TIME, HIGH_VALUE_THRESHOLD_PAISE } from "../../constants/constants"; // [CHANGED] added HIGH_VALUE_THRESHOLD_PAISE
import { db, recoveryAttempts, recoveryActions, auditLogs, customers, and, sql } from "@repo/db";
import { eq } from "@repo/db";
import { fetchSubscription, createPaymentLink } from "../../services/razorpay.service";
import { classifyDeclineCode, ESCALATION_STEPS } from "@repo/shared";
import { diagnoseFailure, generateRecoveryMessage, determineNextAction, deriveDisplayName } from "../../services/ai.service";
import { runPreActionGuardrails } from "../../lib/guardrails";
import { incrementRecoveryAttempts, markCustomerContacted, markCustomerRecovered } from "../../services/customer.service";
import { sendNotification } from "../../services/notification.service";

export const subscriptionRecovery = inngest.createFunction(
    {
        id: "subscription-recovery",
        concurrency: { limit: MAX_CONCURRENT_RECOVERIES }, // max concurrent recoveries
        triggers: [{ event: "payment/subscription.failed" }],
        idempotency: "event.data.subscriptionId",
        cancelOn: [
            {
                event: "payment/subscription.recovered",
                if: "async.data.subscriptionId == event.data.subscriptionId",
            },
        ],
    },
    async ({ event, step }) => {
        const { subscriptionId, paymentId, amount, currency, declineCode, errorDescription } = event.data;

        // ── Step 1: Classify the failure ──
        const diagnosis = await step.run("ai-diagnose", async () => {
            const result = await diagnoseFailure({
                errorCode: declineCode,
                errorDescription: errorDescription,
                amount,
                currency: currency || DEFAULT_CURRENCY,
                customerEmail: event.data.customerEmail,
            });

            console.log(`AI Diagnosis: ${result.failureCategory} | Action: ${result.recommendedAction}`);
            return result;
        });

        // ── Step 2: Create recovery attempt record ──
        const recovery = await step.run("create-recovery-record", async () => {
            const [existingActive] = await db
                .select({ id: recoveryAttempts.id })
                .from(recoveryAttempts)
                .where(and(
                    eq(recoveryAttempts.razorpayEntityId, subscriptionId),
                    sql`${recoveryAttempts.status} NOT IN ('recovered', 'abandoned', 'escalated')`
                ))
                .limit(1);

            if (existingActive) {
                console.log(`Active recovery already exists for ${subscriptionId}, skipping duplicate`);
                return null;
            }

            const [record] = await db.insert(recoveryAttempts).values({
                type: "subscription_renewal",
                customerId: event.data.customerId,
                razorpayEntityId: subscriptionId,
                status: "detected",
                failureCategory: diagnosis.failureCategory,
                declineCode: declineCode || null,
                amountAtRisk: amount,
                currency: currency || DEFAULT_CURRENCY,
            }).returning();

            if (!record) {
                throw new Error("Failed to create recovery attempt record");
            }

            if (event.data.customerId) {
                await incrementRecoveryAttempts(event.data.customerId);
            }

            return record;
        });
        if (!recovery) {
            return { status: "skipped", reason: "duplicate_active_recovery" };
        }

        // ── Step 3: Log to audit ──
        await step.run("audit-detected", async () => {
            await db.insert(auditLogs).values({
                recoveryAttemptId: recovery.id,
                eventType: "recovery.detected",
                actor: "system",
                action: `Recovery started for subscription ${subscriptionId}. Failure: ${diagnosis.failureCategory}`,
                details: { diagnosis, event: event.data },
            });
        });

        // ── Step 4: Hard decline? Send payment link immediately ──
        if (diagnosis.failureCategory === "hard_decline") {
            const hardDeclineGuardrail = await step.run("guardrails-hard-decline", async () => {
                return await runPreActionGuardrails({
                    customerId: recovery.customerId ?? undefined,
                    amountPaise: amount,
                });
            });

            if (!hardDeclineGuardrail.allowed) {
                await step.run("mark-abandoned-guardrail-hard-decline", async () => {
                    await db.update(recoveryAttempts)
                        .set({ status: "abandoned", abandonedAt: new Date() })
                        .where(eq(recoveryAttempts.id, recovery.id));

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.abandoned",
                        actor: "system",
                        action: `Recovery stopped by guardrail before hard-decline payment link: ${hardDeclineGuardrail.reason}`,
                    });
                });
                return { status: "abandoned", reason: hardDeclineGuardrail.reason, amount };
            }

            await step.run("send-payment-link", async () => {
                const link = await createPaymentLink({
                    amount,
                    currency: currency || DEFAULT_CURRENCY,
                    customerName: deriveDisplayName(event.data.customerEmail),
                    customerEmail: event.data.customerEmail,
                    customerPhone: event.data.customerPhone,
                    description: `Complete your subscription payment`,
                });

                await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: 1,
                    actionType: "send_payment_link",
                    status: "sent",
                    aiReasoning: `Hard decline (${declineCode}) — customer needs to use a different payment method. Sending payment link immediately.`,
                    channel: "email",
                    paymentLinkId: link.id,
                    paymentLinkUrl: link.short_url,
                });

                if (recovery.customerId) {
                    await markCustomerContacted(recovery.customerId);
                }

                console.log(`Payment link sent: ${link.short_url}`);
            });

            // Wait before checking
            await step.sleep("wait-after-payment-link", HARD_DECLINE_WAIT_TIME);

            const recovered = await step.run("check-hard-decline-recovery", async () => {
                try {
                    const sub = await fetchSubscription(subscriptionId);
                    return sub.status === "active";
                } catch (error) {
                    console.log(`Could not fetch subscription ${subscriptionId} (assumed inactive): ${error}`);
                    return false;
                }
            });

            if (recovered) {
                await step.run("mark-recovered-hard", async () => {
                    await db.update(recoveryAttempts)
                        .set({ status: "recovered", amountRecovered: amount, recoveredAt: new Date() })
                        .where(eq(recoveryAttempts.id, recovery.id));

                    if (recovery.customerId) {
                        await markCustomerRecovered(recovery.customerId);
                    }

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.completed",
                        actor: "system",
                        action: `Recovery successful! ₹${amount / 100} recovered from hard decline.`,
                    });
                });
                return { status: "recovered", amount, category: "hard_decline" };
            }
        }

        // ── Step 5: Soft decline / Gateway error → Escalation cascade ──
        for (const escalation of ESCALATION_STEPS) {
            if (escalation.delayHours > 0) {
                const waitTime = ESCALATION_WAIT_TIME || `${escalation.delayHours}h`;
                await step.sleep(`wait-step-${escalation.step}`, waitTime);
            }

            const isRecovered = await step.run(`check-recovery-step-${escalation.step}`, async () => {
                try {
                    const sub = await fetchSubscription(subscriptionId);
                    return sub.status === "active";
                } catch (error) {
                    console.log(`Could not fetch subscription ${subscriptionId} (assumed inactive): ${error}`);
                    return false;
                }
            });

            if (isRecovered) {
                await step.run(`mark-recovered-step-${escalation.step}`, async () => {
                    await db.update(recoveryAttempts)
                        .set({
                            status: "recovered",
                            amountRecovered: amount,
                            recoveredAt: new Date(),
                            currentStep: escalation.step,
                        })
                        .where(eq(recoveryAttempts.id, recovery.id));

                    if (recovery.customerId) {
                        await markCustomerRecovered(recovery.customerId);
                    }

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.completed",
                        actor: "system",
                        action: `Recovery successful at step ${escalation.step} (${escalation.label})! ₹${amount / 100} recovered.`,
                    });
                });
                return { status: "recovered", step: escalation.step, amount };
            }

            // 1. Guardrails Check
            const guardrail = await step.run(`guardrails-step-${escalation.step}`, async () => {
                return await runPreActionGuardrails({
                    customerId: recovery.customerId ?? undefined,
                    amountPaise: amount,
                });
            });

            if (!guardrail.allowed) {
                await step.run(`mark-abandoned-guardrail-${escalation.step}`, async () => {
                    await db.update(recoveryAttempts)
                        .set({ status: "abandoned", abandonedAt: new Date() })
                        .where(eq(recoveryAttempts.id, recovery.id));

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.abandoned",
                        actor: "system",
                        action: `Recovery stopped due to guardrails at step ${escalation.step}: ${guardrail.reason}`,
                    });
                });
                return { status: "abandoned", reason: guardrail.reason, step: escalation.step, amount };
            }

            // 2. Determine Next Action via AI
            const nextAction = await step.run(`determine-action-step-${escalation.step}`, async () => {
                const prev = await db.select().from(recoveryActions).where(eq(recoveryActions.recoveryAttemptId, recovery.id));

                const daysSinceFailure = Math.floor(
                    (Date.now() - new Date(event.data.failedAt || Date.now()).getTime()) / (1000 * 60 * 60 * 24)
                );

                return await determineNextAction({
                    failureCategory: diagnosis.failureCategory,
                    currentStep: escalation.step,
                    maxSteps: ESCALATION_STEPS.length,
                    previousActions: prev.map(p => ({ actionType: p.actionType, status: p.status, channel: p.channel || undefined })),
                    amount,
                    customerOptedOut: false, // Handled by guardrails
                    daysSinceFailure,
                    preferredChannel: guardrail.preferredChannel, // [NEW] AI now sees this before deciding, not just as a fallback after
                });
            });

            if (nextAction.shouldStop) {
                await step.run(`mark-abandoned-ai-${escalation.step}`, async () => {
                    await db.update(recoveryAttempts)
                        .set({ status: "abandoned", abandonedAt: new Date() })
                        .where(eq(recoveryAttempts.id, recovery.id));

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.abandoned",
                        actor: "system",
                        action: `Recovery stopped by AI at step ${escalation.step}: ${nextAction.stopReason}`,
                    });
                });
                return { status: "abandoned", reason: nextAction.stopReason, step: escalation.step, amount };
            }

            // Resolve channel once — AI's pick wins; this fallback chain now mostly
            // just covers the model returning null, since it already sees preferredChannel above
            const channel = nextAction.channel || guardrail.preferredChannel || escalation.channel;
            const isContactAction = nextAction.action === "send_email" || nextAction.action === "send_sms" || nextAction.action === "send_whatsapp";

            // 3. Generate Personalized Message — only for actions that actually contact the customer
            let message: Awaited<ReturnType<typeof generateRecoveryMessage>> | undefined;
            if (isContactAction) {
                message = await step.run(`generate-message-step-${escalation.step}`, async () => {
                    return await generateRecoveryMessage({
                        customerName: deriveDisplayName(event.data.customerEmail),
                        amount,
                        currency: currency || DEFAULT_CURRENCY,
                        failureCategory: diagnosis.failureCategory,
                        escalationStep: escalation.step,
                        maxSteps: ESCALATION_STEPS.length, // [NEW] required param — replaces the old hardcoded "of 5"
                        channel,
                        productDescription: "your subscription",
                    });
                });
            }

            // 4. Execute Action
            await step.run(`execute-step-${escalation.step}`, async () => {
                let paymentLinkId: string | undefined;
                let paymentLinkUrl: string | undefined;

                // [FIX] A payment link isn't just for the "send_payment_link" action — almost
                // every contact action's whole point is getting the customer somewhere they
                // can pay. Mint one for any contact action too, not only when the AI's label
                // literally says send_payment_link.
                const needsLink = nextAction.action === "send_payment_link" || isContactAction;

                if (needsLink) {
                    const expiryHours = Math.max(48 - escalation.step * 6, 12);
                    const link = await createPaymentLink({
                        amount,
                        currency: currency || DEFAULT_CURRENCY,
                        customerName: deriveDisplayName(event.data.customerEmail),
                        customerEmail: event.data.customerEmail,
                        customerPhone: event.data.customerPhone,
                        description: "Complete your subscription payment",
                        expireBy: Math.floor(Date.now() / 1000) + expiryHours * 3600,
                    });
                    paymentLinkId = link.id;
                    paymentLinkUrl = link.short_url;
                }

                await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: escalation.step,
                    actionType: nextAction.action,
                    status: "sent",
                    aiReasoning: nextAction.reasoning,
                    channel,
                    messageContent: message?.body,
                    paymentLinkId,
                    paymentLinkUrl,
                });

                await db.update(recoveryAttempts)
                    .set({ currentStep: escalation.step, status: "intervention_sent" })
                    .where(eq(recoveryAttempts.id, recovery.id));

                if (isContactAction && message) {
                    const recipient = channel === "email" ? event.data.customerEmail : event.data.customerPhone;
                    if (recipient) {
                        await sendNotification(channel, {
                            to: recipient,
                            subject: message.subject,
                            body: message.body,
                            customerName: deriveDisplayName(event.data.customerEmail),
                            actionUrl: paymentLinkUrl,
                            actionText: message.callToAction,
                            tone: message.tone,
                            recoveryAttemptId: recovery.id,
                        });
                    }
                }

                if (isContactAction && recovery.customerId) {
                    await markCustomerContacted(recovery.customerId);
                }

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: `recovery.escalation.step-${escalation.step}`,
                    actor: "system",
                    action: `Executed ${nextAction.action} via ${channel}`,
                });
            });
        }

        // All steps exhausted — high-value recoveries get escalated to a human instead of abandoned
        await step.run("mark-abandoned", async () => {
            const isHighValue = amount >= HIGH_VALUE_THRESHOLD_PAISE; // [CHANGED] now imported from constants, was a local const before
            const finalStatus = isHighValue ? "escalated" : "abandoned";

            await db.update(recoveryAttempts)
                .set({ status: finalStatus, abandonedAt: new Date() })
                .where(eq(recoveryAttempts.id, recovery.id));

            await db.insert(auditLogs).values({
                recoveryAttemptId: recovery.id,
                eventType: isHighValue ? "recovery.escalated_to_human" : "recovery.abandoned",
                actor: "system",
                action: isHighValue
                    ? `₹${amount / 100} at risk after ${ESCALATION_STEPS.length} steps — escalating to a human instead of giving up.`
                    : `All ${ESCALATION_STEPS.length} recovery steps exhausted. Marked as abandoned.`,
            });
        });

        return { status: "finalized", totalSteps: ESCALATION_STEPS.length, amount };
    }
);