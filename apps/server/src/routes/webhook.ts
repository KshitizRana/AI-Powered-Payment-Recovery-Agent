import { Hono } from "hono";
import crypto from "crypto";
import { db, auditLogs } from "@repo/db";
import { WebhookEvent } from "@repo/shared";
import type { RazorpayWebhookPayload } from "@repo/shared";
import config from "../config/config";
import Razorpay from "razorpay";
import { inngest } from "../inngest/client";
import { upsertCustomer } from "../services/customer.service";

export const webhookRoutes = new Hono();

function verifyWebhookSignature(
    body: string,
    signature: string,
    secret: string
): boolean {
    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

    if (signature.length !== expectedSignature.length) {
        return false;
    }
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

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
    } catch {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    const eventType = payload.event;
    console.log(`Webhook received: ${eventType}`);

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
            console.log("Payment failed — logging for now");
            // TODO: Handle standalone payment failures (checkout abandonment)
            break;
        }
        case WebhookEvent.PAYMENT_CAPTURED: {
            console.log("Payment captured successfully");
            break;
        }
        default:
            console.log(`Unhandled webhook event: ${eventType}`);
    }

    return c.json({ status: "received", event: eventType });
});
