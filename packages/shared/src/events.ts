import type { RazorpayPaymentEntity, RazorpaySubscriptionEntity } from "./payment";

export enum WebhookEvent {
  PAYMENT_FAILED = "payment.failed",
  PAYMENT_CAPTURED = "payment.captured",
  SUBSCRIPTION_PENDING = "subscription.pending",
  SUBSCRIPTION_HALTED = "subscription.halted",
  SUBSCRIPTION_ACTIVATED = "subscription.activated",
  SUBSCRIPTION_CANCELLED = "subscription.cancelled",
  ORDER_PAID = "order.paid",
}

export interface RazorpayWebhookPayload {
  entity: "event";
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    payment?: { entity: RazorpayPaymentEntity };
    subscription?: { entity: RazorpaySubscriptionEntity };
  };
  created_at: number;
}

export interface RecoveryEvents {
  "payment/subscription.failed": {
    data: {
      subscriptionId: string;
      paymentId?: string;
      customerId?: string;
      customerEmail?: string;
      customerPhone?: string;
      amount: number;
      currency: string;
      declineCode?: string;
      errorDescription?: string;
      failedAt: string;
    };
  };
  "payment/checkout.abandoned": {
    data: {
      orderId: string;
      customerId?: string
      customerEmail?: string;
      customerPhone?: string;
      amount: number;
      currency: string;
      method?: string;
      abandonedAt: string;
    };
  };
  "recovery/check-status": {
    data: {
      recoveryAttemptId: string;
    };
  };
  "payment/subscription.recovered": {
    data: {
      subscriptionId: string;
      recoveredAt: string;
    };
  };
  "payment/checkout.completed": {
    data: { orderId: string };
  };
}
