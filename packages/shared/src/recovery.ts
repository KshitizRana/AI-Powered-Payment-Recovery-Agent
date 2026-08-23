
export enum RecoveryStatus {
    /** Failure detected from webhook */
    DETECTED = "detected",
    /** AI has diagnosed the root cause */
    DIAGNOSED = "diagnosed",
    /** Intervention planned but not yet executed */
    INTERVENTION_PLANNED = "intervention_planned",
    /** Intervention sent (retry triggered, message sent, etc.) */
    INTERVENTION_SENT = "intervention_sent",
    /** Waiting for customer action or retry result */
    WAITING = "waiting",
    /** Successfully recovered — payment went through! */
    RECOVERED = "recovered",
    /** Escalated to higher-priority channel or human */
    ESCALATED = "escalated",
    /** All attempts exhausted — giving up */
    ABANDONED = "abandoned",
}

export enum RecoveryType {
    SUBSCRIPTION_RENEWAL = "subscription_renewal",
    CHECKOUT_ABANDONMENT = "checkout_abandonment",
}


export enum FailureCategory {
    /** Retriable — temporary issue (insufficient funds, bank timeout) */
    SOFT_DECLINE = "soft_decline",
    /** Needs customer action (expired card, stolen card) */
    HARD_DECLINE = "hard_decline",
    /** Infrastructure issue (gateway error, bank not responding) */
    GATEWAY_ERROR = "gateway_error",
    /** Customer left before completing payment */
    CHECKOUT_ABANDONED = "checkout_abandoned",
    /** Unknown — couldn't classify */
    UNKNOWN = "unknown",
}

export enum ActionType {
    /** Retry the payment via Razorpay */
    RETRY_PAYMENT = "retry_payment",
    /** Generate and send a payment link */
    SEND_PAYMENT_LINK = "send_payment_link",
    /** Send recovery email */
    SEND_EMAIL = "send_email",
    /** Send recovery SMS */
    SEND_SMS = "send_sms",
    /** Send WhatsApp message */
    SEND_WHATSAPP = "send_whatsapp",
    /** Escalate to next level */
    ESCALATE = "escalate",
    /** Do nothing — stop recovery */
    NO_ACTION = "no_action",
}

export enum ActionStatus {
    PENDING = "pending",
    SENT = "sent",
    DELIVERED = "delivered",
    FAILED = "failed",
}

export enum NotificationChannel {
    EMAIL = "email",
    SMS = "sms",
    WHATSAPP = "whatsapp",
}

export enum NotificationStatus {
    QUEUED = "queued",
    SENT = "sent",
    DELIVERED = "delivered",
    FAILED = "failed",
    BOUNCED = "bounced",
}


export const ESCALATION_STEPS = [
    { step: 1, label: "Friendly Reminder", delayHours: 0, channel: NotificationChannel.EMAIL },
    { step: 2, label: "Payment Link SMS", delayHours: 24, channel: NotificationChannel.SMS },
    { step: 3, label: "Urgent Email", delayHours: 72, channel: NotificationChannel.EMAIL },
    { step: 4, label: "Final Notice", delayHours: 120, channel: NotificationChannel.EMAIL },
    { step: 5, label: "Abandoned", delayHours: 168, channel: NotificationChannel.EMAIL },
] as const;

export const MAX_RECOVERY_ATTEMPTS = ESCALATION_STEPS.length;
