import { FailureCategory } from "./recovery";

interface DeclineCodeInfo {
    code: string;
    category: FailureCategory;
    description: string;
    retriable: boolean;
    customerActionNeeded: boolean;
}

export const DECLINE_CODE_MAP: Record<string, DeclineCodeInfo> = {
    // ---- SOFT DECLINES (retriable) ----
    BAD_REQUEST_ERROR: {
        code: "BAD_REQUEST_ERROR",
        category: FailureCategory.SOFT_DECLINE,
        description: "Temporary processing error",
        retriable: true,
        customerActionNeeded: false,
    },
    GATEWAY_ERROR: {
        code: "GATEWAY_ERROR",
        category: FailureCategory.GATEWAY_ERROR,
        description: "Payment gateway is down or unresponsive",
        retriable: true,
        customerActionNeeded: false,
    },
    SERVER_ERROR: {
        code: "SERVER_ERROR",
        category: FailureCategory.GATEWAY_ERROR,
        description: "Razorpay server error",
        retriable: true,
        customerActionNeeded: false,
    },

    // ---- Specific error_reason codes ----
    // Soft — can retry
    insufficient_balance: {
        code: "insufficient_balance",
        category: FailureCategory.SOFT_DECLINE,
        description: "Customer has insufficient balance",
        retriable: true, // might work on salary day
        customerActionNeeded: false,
    },
    bank_transaction_limit_exceeded: {
        code: "bank_transaction_limit_exceeded",
        category: FailureCategory.SOFT_DECLINE,
        description: "Daily transaction limit exceeded",
        retriable: true, // will work next day
        customerActionNeeded: false,
    },
    issuer_unavailable: {
        code: "issuer_unavailable",
        category: FailureCategory.GATEWAY_ERROR,
        description: "Issuing bank is temporarily unavailable",
        retriable: true,
        customerActionNeeded: false,
    },
    network_error: {
        code: "network_error",
        category: FailureCategory.GATEWAY_ERROR,
        description: "Network connectivity issue",
        retriable: true,
        customerActionNeeded: false,
    },
    payment_processing_cancelled: {
        code: "payment_processing_cancelled",
        category: FailureCategory.SOFT_DECLINE,
        description: "Payment was cancelled during processing",
        retriable: true,
        customerActionNeeded: false,
    },
    upi_server_not_responding: {
        code: "upi_server_not_responding",
        category: FailureCategory.GATEWAY_ERROR,
        description: "UPI server is not responding",
        retriable: true,
        customerActionNeeded: false,
    },

    // ---- HARD DECLINES (need customer action) ----
    card_expired: {
        code: "card_expired",
        category: FailureCategory.HARD_DECLINE,
        description: "Card has expired",
        retriable: false,
        customerActionNeeded: true,
    },
    card_declined: {
        code: "card_declined",
        category: FailureCategory.HARD_DECLINE,
        description: "Card was declined by the issuing bank",
        retriable: false,
        customerActionNeeded: true,
    },
    lost_or_stolen_card: {
        code: "lost_or_stolen_card",
        category: FailureCategory.HARD_DECLINE,
        description: "Card reported as lost or stolen",
        retriable: false,
        customerActionNeeded: true,
    },
    invalid_card_number: {
        code: "invalid_card_number",
        category: FailureCategory.HARD_DECLINE,
        description: "Card number is invalid",
        retriable: false,
        customerActionNeeded: true,
    },
    invalid_vpa: {
        code: "invalid_vpa",
        category: FailureCategory.HARD_DECLINE,
        description: "UPI VPA/ID is invalid",
        retriable: false,
        customerActionNeeded: true,
    },
    authentication_failed: {
        code: "authentication_failed",
        category: FailureCategory.HARD_DECLINE,
        description: "3DS or OTP authentication failed",
        retriable: false,
        customerActionNeeded: true,
    },
    international_transaction_not_allowed: {
        code: "international_transaction_not_allowed",
        category: FailureCategory.HARD_DECLINE,
        description: "International transactions not enabled on card",
        retriable: false,
        customerActionNeeded: true,
    },
    mandate_not_active: {
        code: "mandate_not_active",
        category: FailureCategory.HARD_DECLINE,
        description: "UPI/NACH mandate is not active",
        retriable: false,
        customerActionNeeded: true,
    },
    mandate_revoked: {
        code: "mandate_revoked",
        category: FailureCategory.HARD_DECLINE,
        description: "Customer revoked the mandate",
        retriable: false,
        customerActionNeeded: true,
    },
};

export function classifyDeclineCode(errorCode?: string, errorReason?: string): DeclineCodeInfo {
    if (errorReason && DECLINE_CODE_MAP[errorReason]) {
        return DECLINE_CODE_MAP[errorReason];
    }

    // Fall back to error_code
    if (errorCode && DECLINE_CODE_MAP[errorCode]) {
        return DECLINE_CODE_MAP[errorCode];
    }

    // Unknown
    return {
        code: errorCode || errorReason || "UNKNOWN",
        category: FailureCategory.UNKNOWN,
        description: "Unknown error — could not classify",
        retriable: false,
        customerActionNeeded: false,
    };
}
