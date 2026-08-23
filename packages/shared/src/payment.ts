export enum PaymentStatus {
  CREATED = "created",
  AUTHORIZED = "authorized",
  CAPTURED = "captured",
  REFUNDED = "refunded",
  FAILED = "failed",
}

export enum PaymentMethod {
  CARD = "card",
  UPI = "upi",
  NETBANKING = "netbanking",
  WALLET = "wallet",
  EMI = "emi",
  BANK_TRANSFER = "bank_transfer",
}

export enum SubscriptionStatus {
  CREATED = "created",
  AUTHENTICATED = "authenticated",
  ACTIVE = "active",
  PENDING = "pending",
  HALTED = "halted",
  CANCELLED = "cancelled",
  COMPLETED = "completed",
  EXPIRED = "expired",
  PAUSED = "paused",
}

export interface RazorpayPaymentEntity {
  id: string;
  entity: "payment";
  amount: number;
  currency: string;
  status: string;
  method: string;
  description?: string;
  order_id?: string;
  email?: string;
  contact?: string;
  error_code?: string;
  error_description?: string;
  error_reason?: string;
  error_source?: string;
  created_at: number;
}

export interface RazorpaySubscriptionEntity {
  id: string;
  entity: "subscription";
  plan_id: string;
  status: string;
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  offer_id?: string;
  total_count: number;
  paid_count: number;
  remaining_count: number;
  customer_id?: string;
  created_at: number;
}
