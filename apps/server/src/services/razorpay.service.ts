import Razorpay from "razorpay";
import config from "../config/config";
import { RAZORPAY_TIMEOUT_MS } from "../constants/constants";

const razorpay = new Razorpay({
    key_id: config.RAZORPAY_KEY_ID,
    key_secret: config.RAZORPAY_KEY_SECRET,
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        ),
    ]);
}

export async function fetchPayment(paymentId: string) {
    try {
        const payment = await withTimeout(
            razorpay.payments.fetch(paymentId),
            RAZORPAY_TIMEOUT_MS,
            `fetchPayment(${paymentId})`
        );
        return payment;
    } catch (error) {
        console.error(`Failed to fetch payment ${paymentId}:`, error);
        throw error;
    }
}

export async function fetchSubscription(subscriptionId: string) {
    try {
        const subscription = await withTimeout(
            razorpay.subscriptions.fetch(subscriptionId),
            RAZORPAY_TIMEOUT_MS,
            `fetchSubscription(${subscriptionId})`
        );
        return subscription;
    } catch (error: any) {
        console.error(`Failed to fetch subscription ${subscriptionId}:`, error);
        const statusCode = error?.statusCode ?? error?.status;
        const wrapped = new Error(
            error?.message || `Razorpay API Error: ${JSON.stringify(error)}`
        ) as any;
        wrapped.statusCode = statusCode;
        throw wrapped;
    }
}

interface CreatePaymentLinkOptions {
    amount: number; 
    currency?: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    description?: string;
    expireBy?: number;
}

export async function createPaymentLink(options: CreatePaymentLinkOptions) {
    try {
        const link = await withTimeout(
            razorpay.paymentLink.create({
                amount: options.amount,
                currency: options.currency || "INR",
                description: options.description || "Complete your payment",
                customer: {
                    name: options.customerName,
                    email: options.customerEmail,
                    contact: options.customerPhone,
                },
                notify: {
                    sms: !!options.customerPhone,
                    email: !!options.customerEmail,
                },
                reminder_enable: true,
                callback_url: `${config.FRONTEND_URL}/payment/success`,
                callback_method: "get",
                ...(options.expireBy && { expire_by: options.expireBy }),
            }),
            RAZORPAY_TIMEOUT_MS,
            `createPaymentLink`
        );

        console.log(`Payment link created: ${link.short_url}`);
        return link;
    } catch (error) {
        console.error("Failed to create payment link:", error);
        throw error;
    }
}

export async function retrySubscriptionCharge(subscriptionId: string) {
    try {
        const subscription = await razorpay.subscriptions.fetch(subscriptionId);
        return subscription;
    } catch (error) {
        console.error(`Failed to retry subscription ${subscriptionId}:`, error);
        throw error;
    }
}

export async function fetchOrder(orderId: string) {
    try {
        const order = await withTimeout(
            razorpay.orders.fetch(orderId),
            RAZORPAY_TIMEOUT_MS,
            `fetchOrder(${orderId})`
        );
        return order;
    } catch (error) {
        console.error(`Failed to fetch order ${orderId}:`, error);
        throw error;
    }
}

export { razorpay };
