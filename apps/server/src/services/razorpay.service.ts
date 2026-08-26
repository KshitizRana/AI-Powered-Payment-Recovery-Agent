import Razorpay from "razorpay";
import config from "../config/config";


const razorpay = new Razorpay({
    key_id: config.RAZORPAY_KEY_ID,
    key_secret: config.RAZORPAY_KEY_SECRET,
});

export async function fetchPayment(paymentId: string) {
    try {
        const payment = await razorpay.payments.fetch(paymentId);
        return payment;
    } catch (error) {
        console.error(`Failed to fetch payment ${paymentId}:`, error);
        throw error;
    }
}

export async function fetchSubscription(subscriptionId: string) {
    try {
        const subscription = await razorpay.subscriptions.fetch(subscriptionId);
        return subscription;
    } catch (error: any) {
        console.error(`Failed to fetch subscription ${subscriptionId}:`, error);
        if (error && typeof error === 'object' && !error.message) {
            throw new Error(`Razorpay API Error: ${JSON.stringify(error)}`);
        }
        throw error;
    }
}

interface CreatePaymentLinkOptions {
    amount: number; // in paise
    currency?: string;
    customerName?: string;
    customerEmail?: string;
    customerPhone?: string;
    description?: string;
    expireBy?: number; // Unix timestamp
}

export async function createPaymentLink(options: CreatePaymentLinkOptions) {
    try {
        const link = await razorpay.paymentLink.create({
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
        });

        console.log(`Payment link created: ${link.short_url}`);
        return link;
    } catch (error) {
        console.error("Failed to create payment link:", error);
        throw error;
    }
}

export async function retrySubscriptionCharge(subscriptionId: string) {
    try {
        // Razorpay doesn't have a direct "retry" — the subscription auto-retries
        // based on its config. But you can fetch the latest state.
        const subscription = await razorpay.subscriptions.fetch(subscriptionId);
        return subscription;
    } catch (error) {
        console.error(`Failed to retry subscription ${subscriptionId}:`, error);
        throw error;
    }
}

export { razorpay };
