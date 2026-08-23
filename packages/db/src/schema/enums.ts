import { pgEnum } from "drizzle-orm/pg-core";

// Payment
export const paymentStatusEnum = pgEnum("payment_status", [
    "created", "authorized", "captured", "refunded", "failed"
]);

export const paymentMethodEnum = pgEnum("payment_method", [
    "card", "upi", "netbanking", "wallet", "emi", "bank_transfer"
]);

// Subscription
export const subscriptionStatusEnum = pgEnum("subscription_status", [
    "created", "authenticated", "active", "pending", "halted",
    "cancelled", "completed", "expired", "paused"
]);

// Recovery
export const recoveryTypeEnum = pgEnum("recovery_type", [
    "subscription_renewal", "checkout_abandonment"
]);

export const recoveryStatusEnum = pgEnum("recovery_status", [
    "detected", "diagnosed", "intervention_planned", "intervention_sent",
    "waiting", "recovered", "escalated", "abandoned"
]);

export const failureCategoryEnum = pgEnum("failure_category", [
    "soft_decline", "hard_decline", "gateway_error", "checkout_abandoned", "unknown"
]);

// Actions
export const actionTypeEnum = pgEnum("action_type", [
    "retry_payment", "send_payment_link", "send_email",
    "send_sms", "send_whatsapp", "escalate", "no_action"
]);

export const actionStatusEnum = pgEnum("action_status", [
    "pending", "sent", "delivered", "failed"
]);

// Notifications
export const notificationChannelEnum = pgEnum("notification_channel", [
    "email", "sms", "whatsapp"
]);

export const notificationStatusEnum = pgEnum("notification_status", [
    "queued", "sent", "delivered", "failed", "bounced"
]);

// Audit
export const auditActorEnum = pgEnum("audit_actor", [
    "system", "ai", "webhook", "user"
]);
