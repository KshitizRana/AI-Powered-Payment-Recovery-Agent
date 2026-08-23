import { Hono } from "hono";
import crypto from "crypto";
import { db, auditLogs } from "@repo/db";
import { WebhookEvent } from "@repo/shared";
import type { RazorpayWebhookPayload } from "@repo/shared";
import config from "../config/config";
import Razorpay from "razorpay";

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
            console.log("Subscription entered pending state — recovery needed");
            break;

        case WebhookEvent.SUBSCRIPTION_HALTED:
            console.log("Subscription halted — all retries exhausted");
            break;

        case WebhookEvent.SUBSCRIPTION_ACTIVATED:
            console.log("Subscription re-activated — recovery successful!");
            break;

        case WebhookEvent.PAYMENT_FAILED:
            console.log("Payment failed");
            break;

        case WebhookEvent.PAYMENT_CAPTURED:
            console.log("Payment captured");
            break;

        default:
            console.log(`Unhandled webhook event: ${eventType}`);
    }

    return c.json({ status: "received", event: eventType });
});
