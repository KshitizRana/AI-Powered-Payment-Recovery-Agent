import { inngest } from "../client";
import { MAX_CONCURRENT_RECOVERIES, HARD_DECLINE_WAIT_TIME, DEFAULT_CURRENCY, ESCALATION_WAIT_TIME } from "../../constants/constants";
import { db, recoveryAttempts, recoveryActions, auditLogs, customers } from "@repo/db";
import { eq } from "@repo/db";
import { fetchSubscription, createPaymentLink } from "../../services/razorpay.service";
import { classifyDeclineCode, ESCALATION_STEPS } from "@repo/shared";
import { diagnoseFailure, generateRecoveryMessage, determineNextAction } from "../../services/ai.service";
import { runPreActionGuardrails } from "../../lib/guardrails";

export const subscriptionRecovery = inngest.createFunction(
    {
        id: "subscription-recovery",
        concurrency: { limit: MAX_CONCURRENT_RECOVERIES }, // max concurrent recoveries
        triggers: [{ event: "payment/subscription.failed" }],
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
            const [record] = await db.insert(recoveryAttempts).values({
                type: "subscription_renewal",
                subscriptionId: event.data.subscriptionId ? undefined : undefined, // Link if you have UUID
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
            return record;
        });

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
            await step.run("send-payment-link", async () => {
                const link = await createPaymentLink({
                    amount,
                    currency: currency || DEFAULT_CURRENCY,
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
                // Using the constant for fast testing, otherwise would be `${escalation.delayHours}h`
                const waitTime = ESCALATION_WAIT_TIME || `${escalation.delayHours}h`;
                await step.sleep(`wait-step-${escalation.step}`, waitTime);
            }

            // Check if already recovered
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

                    await db.insert(auditLogs).values({
                        recoveryAttemptId: recovery.id,
                        eventType: "recovery.completed",
                        actor: "system",
                        action: `Recovery successful at step ${escalation.step} (${escalation.label})! ₹${amount / 100} recovered.`,
                    });
                });
                return { status: "recovered", step: escalation.step, amount };
            }

            // Not recovered — execute escalation action

            // 1. Guardrails Check
            const guardrail = await step.run(`guardrails-step-${escalation.step}`, async () => {
                return await runPreActionGuardrails({
                    customerId: event.data.customerId,
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
                return await determineNextAction({
                    failureCategory: diagnosis.failureCategory,
                    currentStep: escalation.step,
                    maxSteps: ESCALATION_STEPS.length,
                    previousActions: prev.map(p => ({ actionType: p.actionType, status: p.status, channel: p.channel || undefined })),
                    amount,
                    customerOptedOut: false, // Handled by guardrails
                    daysSinceFailure: 0,
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

            // 3. Generate Personalized Message
            const message = await step.run(`generate-message-step-${escalation.step}`, async () => {
                return await generateRecoveryMessage({
                    customerName: event.data.customerEmail || "Valued Customer",
                    amount,
                    currency: currency || DEFAULT_CURRENCY,
                    failureCategory: diagnosis.failureCategory,
                    escalationStep: escalation.step,
                    channel: nextAction.channel || escalation.channel,
                    productDescription: "your subscription",
                });
            });

            // 4. Execute Action
            await step.run(`execute-step-${escalation.step}`, async () => {
                await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: escalation.step,
                    actionType: nextAction.action,
                    status: "sent",
                    aiReasoning: nextAction.reasoning,
                    channel: nextAction.channel || escalation.channel,
                    messageContent: message.body,
                });

                await db.update(recoveryAttempts)
                    .set({ currentStep: escalation.step, status: "intervention_sent" })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: `recovery.escalation.step-${escalation.step}`,
                    actor: "system",
                    action: `Executed ${nextAction.action} via ${nextAction.channel || escalation.channel}`,
                });
            });
        }

        // All steps exhausted — mark abandoned
        await step.run("mark-abandoned", async () => {
            await db.update(recoveryAttempts)
                .set({ status: "abandoned", abandonedAt: new Date() })
                .where(eq(recoveryAttempts.id, recovery.id));

            await db.insert(auditLogs).values({
                recoveryAttemptId: recovery.id,
                eventType: "recovery.abandoned",
                actor: "system",
                action: `All ${ESCALATION_STEPS.length} recovery steps exhausted. Marked as abandoned.`,
            });
        });

        return { status: "abandoned", totalSteps: ESCALATION_STEPS.length, amount };
    }
);
