import { inngest } from "../client";
import { db, recoveryAttempts, recoveryActions, auditLogs, customers } from "@repo/db";
import { eq } from "@repo/db";
import { fetchSubscription, createPaymentLink } from "../../services/razorpay.service";
import { classifyDeclineCode, ESCALATION_STEPS } from "@repo/shared";

export const subscriptionRecovery = inngest.createFunction(
    {
        id: "subscription-recovery",
        concurrency: { limit: 10 }, // max 10 concurrent recoveries
        triggers: [{ event: "payment/subscription.failed" }],
    },
    async ({ event, step }) => {
        const { subscriptionId, paymentId, amount, currency, declineCode, errorDescription } = event.data;

        // ── Step 1: Classify the failure ──
        const classification = await step.run("classify-failure", async () => {
            const result = classifyDeclineCode(declineCode, errorDescription);
            console.log(`Classified: ${result.category} | Retriable: ${result.retriable}`);
            return result;
        });

        // ── Step 2: Create recovery attempt record ──
        const recovery = await step.run("create-recovery-record", async () => {
            const [record] = await db.insert(recoveryAttempts).values({
                type: "subscription_renewal",
                subscriptionId: event.data.subscriptionId ? undefined : undefined, // Link if you have UUID
                razorpayEntityId: subscriptionId,
                status: "detected",
                failureCategory: classification.category,
                declineCode: declineCode || null,
                amountAtRisk: amount,
                currency: currency || "INR",
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
                action: `Recovery started for subscription ${subscriptionId}. Failure: ${classification.category}`,
                details: { classification, event: event.data },
            });
        });

        // ── Step 4: Hard decline? Send payment link immediately ──
        if (classification.category === "hard_decline") {
            await step.run("send-payment-link", async () => {
                const link = await createPaymentLink({
                    amount,
                    currency: currency || "INR",
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

            // Wait 2 days then check
            await step.sleep("wait-after-payment-link", "2d");

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
                await step.sleep(`wait-step-${escalation.step}`, `${escalation.delayHours}h`);
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
            // TODO (Day 3): Replace this with AI-determined action
            await step.run(`execute-step-${escalation.step}`, async () => {
                // For now, just log + create a recovery action record
                await db.insert(recoveryActions).values({
                    recoveryAttemptId: recovery.id,
                    stepNumber: escalation.step,
                    actionType: "send_email", // TODO: AI picks this
                    status: "sent",
                    aiReasoning: `Escalation step ${escalation.step}: ${escalation.label}`,
                    channel: escalation.channel,
                    messageContent: `Recovery message for step ${escalation.step}`, // TODO: AI generates
                });

                await db.update(recoveryAttempts)
                    .set({ currentStep: escalation.step, status: "intervention_sent" })
                    .where(eq(recoveryAttempts.id, recovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: recovery.id,
                    eventType: `recovery.escalation.step-${escalation.step}`,
                    actor: "system",
                    action: `Executed ${escalation.label} via ${escalation.channel}`,
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
