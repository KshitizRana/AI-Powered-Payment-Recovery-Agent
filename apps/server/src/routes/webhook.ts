import { Hono } from "hono";
import crypto from "crypto";
import { db, auditLogs, recoveryAttempts, and, eq, processedWebhooks } from "@repo/db";
import { WebhookEvent } from "@repo/shared";
import type { RazorpayWebhookPayload } from "@repo/shared";
import config from "../config/config";
import Razorpay from "razorpay";
import { inngest } from "../inngest/client";
import { upsertCustomer } from "../services/customer.service";

export const webhookRoutes = new Hono();

webhookRoutes.post("/razorpay", async (c) => {
    const webhookSecret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error("RAZORPAY_WEBHOOK_SECRET not configured");
        return c.json({ error: "Webhook secret not configured" }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-razorpay-signature");

    if (!signature) {
        console.warn("Webhook received without signature");
        return c.json({ error: "Missing signature" }, 401);
    }

    const isValid = Razorpay.validateWebhookSignature(rawBody, signature, webhookSecret)
    if (!isValid) {
        console.warn("Webhook signature verification failed");
        return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: RazorpayWebhookPayload;
    try {
        payload = JSON.parse(rawBody);
        if (!payload.event || !payload.payload) {
            console.warn("Malformed webhook payload — missing event or payload field");
            return c.json({ error: "Malformed payload" }, 400);
        }
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    const eventType = payload.event;
    console.log(`Webhook received: ${eventType}`);

    const entityId = payload.payload.payment?.entity?.id
        || payload.payload.subscription?.entity?.id
        || "unknown";
    const webhookId = `${payload.event}:${entityId}:${payload.created_at}`;

    try {
        await db.insert(processedWebhooks).values({
            webhookId,
            eventType: payload.event,
        });
    } catch (error: any) {
        if (error?.code === "23505") {
            console.log(`Duplicate webhook skipped: ${webhookId}`);
            return c.json({ status: "duplicate", webhookId });
        }
        throw error;
    }

    await db.insert(auditLogs).values({
        eventType: "webhook.received",
        actor: "webhook",
        action: `Received Razorpay webhook: ${eventType}`,
        details: {
            event: eventType,
            contains: payload.contains,
            accountId: payload.account_id,
        },
    });

    switch (eventType) {
        case WebhookEvent.SUBSCRIPTION_PENDING:
        case WebhookEvent.SUBSCRIPTION_HALTED: {
            console.log(`Subscription failure detected — triggering recovery`);
            const sub = payload.payload.subscription?.entity;
            const payment = payload.payload.payment?.entity;
            const customer = await upsertCustomer({
                razorpayCustomerId: sub?.customer_id,
                email: payment?.email,
                phone: payment?.contact,
            });
            await inngest.send({
                name: "payment/subscription.failed",
                data: {
                    subscriptionId: sub?.id || "unknown",
                    paymentId: payment?.id,
                    customerId: customer?.id,
                    customerEmail: payment?.email,
                    customerPhone: payment?.contact,
                    amount: payment?.amount || 0,
                    currency: payment?.currency || "INR",
                    declineCode: payment?.error_code,
                    errorDescription: payment?.error_description,
                    failedAt: new Date().toISOString(),
                },
            });
            break;
        }
        case WebhookEvent.SUBSCRIPTION_ACTIVATED: {
            const sub = payload.payload.subscription?.entity;
            console.log(` Subscription ${sub?.id} re-activated — notifying any running recovery`);

            await inngest.send({
                name: "payment/subscription.recovered",
                data: {
                    subscriptionId: sub?.id || "unknown",
                    recoveredAt: new Date().toISOString(),
                },
            });
            break;
        }
        case WebhookEvent.PAYMENT_FAILED: {
            const payment = payload.payload.payment?.entity;
            const isSubscriptionRetry = !!payload.payload.subscription;

            if (isSubscriptionRetry) {
                console.log("Standalone payment.failed but subscription context present — already handled above");
                break;
            }

            console.log(`Standalone checkout payment failed — treating as abandonment: ${payment?.order_id}`);

            const customer = await upsertCustomer({
                razorpayCustomerId: payment?.customer_id,
                email: payment?.email,
                phone: payment?.contact,
            });

            await inngest.send({
                name: "payment/checkout.abandoned",
                data: {
                    orderId: payment?.order_id || "unknown",
                    customerId: customer?.id,
                    customerEmail: payment?.email,
                    customerPhone: payment?.contact,
                    amount: payment?.amount || 0,
                    currency: payment?.currency || "INR",
                    method: payment?.method,
                    abandonedAt: new Date().toISOString(),
                },
            });
            break;
        }
        case WebhookEvent.PAYMENT_CAPTURED: {
            const payment = payload.payload.payment?.entity;
            console.log(`Payment captured: ${payment?.id}`);
            // Check if there's an active checkout recovery for this order
            if (payment?.order_id) {
                const [activeRecovery] = await db.select()
                    .from(recoveryAttempts)
                    .where(
                        and(
                            eq(recoveryAttempts.razorpayEntityId, payment.order_id),
                            eq(recoveryAttempts.type, "checkout_abandonment"),
                        )
                    )
                    .limit(1);
                if (activeRecovery && activeRecovery.status !== "recovered") {
                    await db.update(recoveryAttempts)
                        .set({
                            status: "recovered",
                            amountRecovered: payment.amount,
                            recoveredAt: new Date(),
                        })
                        .where(eq(recoveryAttempts.id, activeRecovery.id));
                    await db.insert(auditLogs).values({
                        recoveryAttemptId: activeRecovery.id,
                        eventType: "checkout.recovery.completed",
                        actor: "webhook",
                        action: `Payment captured for order ${payment.order_id}! ₹${payment.amount / 100} recovered.`,
                    });
                }
            }

            break;
        }
        case WebhookEvent.ORDER_PAID: {
            const order = payload.payload.payment?.entity;
            const payment = payload.payload.payment?.entity;
            const orderId = order?.id || payment?.order_id || "unknown";
            console.log(`Order paid — marking recovery as recovered & cancelling workflow`);
            // Mark the recovery as recovered in DB BEFORE cancelling the Inngest function
            const [activeRecovery] = await db.select()
                .from(recoveryAttempts)
                .where(
                    and(
                        eq(recoveryAttempts.razorpayEntityId, orderId),
                        eq(recoveryAttempts.type, "checkout_abandonment"),
                    )
                )
                .limit(1);
            if (activeRecovery && activeRecovery.status !== "recovered") {
                await db.update(recoveryAttempts)
                    .set({
                        status: "recovered",
                        amountRecovered: payment?.amount || activeRecovery.amountAtRisk,
                        recoveredAt: new Date(),
                    })
                    .where(eq(recoveryAttempts.id, activeRecovery.id));
                await db.insert(auditLogs).values({
                    recoveryAttemptId: activeRecovery.id,
                    eventType: "recovery.completed",
                    actor: "webhook",
                    action: `Order ${orderId} paid! ₹${(payment?.amount || activeRecovery.amountAtRisk) / 100} recovered.`,
                });
            }
            // Now cancel the Inngest function (it's safe — DB is already updated)
            await inngest.send({
                name: "payment/checkout.completed",
                data: { orderId },
            });
            break;
        }
        case WebhookEvent.SUBSCRIPTION_CANCELLED: {
            const sub = payload.payload.subscription?.entity;
            console.log(`Subscription ${sub?.id} cancelled by customer — stopping any active recovery`);

            const [activeRecovery] = await db.select()
                .from(recoveryAttempts)
                .where(and(
                    eq(recoveryAttempts.razorpayEntityId, sub?.id || ""),
                    eq(recoveryAttempts.type, "subscription_renewal"),
                ))
                .limit(1);

            if (activeRecovery && !["recovered", "abandoned", "escalated"].includes(activeRecovery.status)) {
                await db.update(recoveryAttempts)
                    .set({ status: "abandoned", abandonedAt: new Date() })
                    .where(eq(recoveryAttempts.id, activeRecovery.id));

                await db.insert(auditLogs).values({
                    recoveryAttemptId: activeRecovery.id,
                    eventType: "recovery.abandoned",
                    actor: "webhook",
                    action: `Subscription ${sub?.id} was cancelled by the customer — this was never a failure to fix, recovery stopped.`,
                });
            }

            await inngest.send({ name: "payment/subscription.cancelled", data: { subscriptionId: sub?.id || "unknown" } });
            break;
        }

        default:
            console.log(`Unhandled webhook event: ${eventType}`);
    }

    return c.json({ status: "received", event: eventType });
});
