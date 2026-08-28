import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import config from "../config/config";
import { classifyDeclineCode, type FailureCategory, type ActionType, type NotificationChannel } from "@repo/shared";
import { AI_MODEL, MAX_RECOVERY_WINDOW_DAYS, DEFAULT_WAIT_HOURS_BETWEEN_STEPS, AI_DIAGNOSIS_TEMPERATURE, AI_MESSAGE_TEMPERATURE, AI_NEXT_ACTION_TEMPERATURE } from "../constants/constants";

const openAIClient = new OpenAI({
    apiKey: config.OPENAI_API_KEY
});

// ─── Zod Schemas for Structured Output ───

const DiagnosisSchema = z.object({
    failureCategory: z.enum([
        "soft_decline", "hard_decline", "gateway_error", "checkout_abandoned", "unknown"
    ]),
    rootCause: z.string().describe("Clear, concise explanation of why the payment failed"),
    isRetriable: z.boolean(),
    customerActionNeeded: z.boolean(),
    urgency: z.enum(["low", "medium", "high", "critical"]),
    recommendedAction: z.enum([
        "retry_payment", "send_payment_link", "send_email",
        "send_sms", "send_whatsapp", "escalate", "no_action"
    ]),
    reasoning: z.string().describe("Why this action was chosen over alternatives"),
});

const RecoveryMessageSchema = z.object({
    subject: z.string().describe("Email subject line (keep under 60 chars)"),
    body: z.string().describe("The recovery message body"),
    tone: z.enum(["friendly", "urgent", "final_notice"]),
    callToAction: z.string().describe("The primary CTA text"),
});

const NextActionSchema = z.object({
    action: z.enum([
        "retry_payment", "send_payment_link", "send_email",
        "send_sms", "send_whatsapp", "escalate", "no_action"
    ]),
    channel: z.enum(["email", "sms", "whatsapp"]).nullable(),
    reasoning: z.string(),
    shouldStop: z.boolean().describe("True if we should stop recovery entirely"),
    stopReason: z.string().nullable().describe("Why we should stop, if applicable"),
    waitHours: z.number().describe("How many hours to wait before this action"),
});

// ─── Types ───

export type DiagnosisResult = z.infer<typeof DiagnosisSchema>;
export type RecoveryMessage = z.infer<typeof RecoveryMessageSchema>;
export type NextActionResult = z.infer<typeof NextActionSchema>;

// ─── 1. Diagnose Failure ───

export async function diagnoseFailure(context: {
    errorCode?: string;
    errorDescription?: string;
    errorReason?: string;
    paymentMethod?: string;
    amount: number;
    currency: string;
    customerEmail?: string;
    previousAttempts?: number;
}): Promise<DiagnosisResult> {
    try {
        const completion = await openAIClient.chat.completions.parse({
            model: AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `You are a payment failure diagnosis expert for an Indian payment gateway (Razorpay).
                    
Your job is to analyze a failed payment and determine:
1. The failure category (soft_decline, hard_decline, gateway_error, etc.)
2. Whether it's retriable or needs customer action
3. The urgency level
4.  The best immediate action to take

Key context:
- Soft declines (insufficient_balance, bank_transaction_limit_exceeded) are retriable — wait and retry
- Hard declines (card_expired, lost_or_stolen_card) need customer to update payment method
- Gateway errors (gateway_error, network_error) are temporary infrastructure issues
- Amount is in paise (divide by 100 for INR)
- Indian payment methods: UPI, cards, netbanking, wallets, EMI

Be concise and actionable in your reasoning.`,
                },
                {
                    role: "user",
                    content: `Diagnose this payment failure:
- Error Code: ${context.errorCode || "unknown"}
- Error Description: ${context.errorDescription || "No description"}
- Error Reason: ${context.errorReason || "unknown"}
- Payment Method: ${context.paymentMethod || "unknown"}
- Amount: ₹${context.amount / 100} (${context.currency})
- Previous recovery attempts: ${context.previousAttempts || 0}`,
                },
            ],
            response_format: zodResponseFormat(DiagnosisSchema, "diagnosis"),
            temperature: AI_DIAGNOSIS_TEMPERATURE,
        });

        const diagnosis = completion.choices[0]?.message?.parsed;
        if (!diagnosis) {
            throw new Error("Failed to parse AI diagnosis");
        }
        return diagnosis;
    } catch (error) {
        console.error("AI diagnosis failed, falling back to rule-based:", error);
        return fallbackDiagnosis(context);
    }
}

// ─── 2. Generate Recovery Message ───

export async function generateRecoveryMessage(context: {
    customerName?: string;
    amount: number;
    currency: string;
    failureCategory: string;
    escalationStep: number;
    channel: string; // "email" | "sms" | "whatsapp"
    productDescription?: string;
}): Promise<RecoveryMessage> {
    const toneMap: Record<number, string> = {
        1: "friendly and helpful",
        2: "gently urgent",
        3: "concerned but professional",
        4: "final notice — respectful but clear this is the last attempt",
        5: "final notice",
    };

    const tone = toneMap[context.escalationStep] || "professional";

    try {
        const completion = await openAIClient.chat.completions.parse({
            model: AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `You are writing a payment recovery message for an Indian customer.

Rules:
- Be empathetic — the customer probably wants to keep their subscription
- NEVER blame the customer. Frame it as "we noticed an issue"
- For email: include a clear CTA (e.g., "Update your payment method")
- For SMS: keep it under 160 characters, include amount in INR
- For WhatsApp: be conversational, use emojis sparingly
- Amount is in paise — display as ₹${context.amount / 100}
- Use the customer's name if available
- Tone should be: ${tone}
- This is escalation step ${context.escalationStep} of 5

Do NOT include any unsubscribe links, legal disclaimers, or filler.
Keep it short, human voice, and actionable.`,
                },
                {
                    role: "user",
                    content: `Write a ${context.channel} recovery message:
- Customer: ${context.customerName || "Valued Customer"}
- Amount: ₹${context.amount / 100}
- Issue: ${context.failureCategory}
- Channel: ${context.channel}
- Escalation Step: ${context.escalationStep} of 5
- Product: ${context.productDescription || "your subscription"}`,
                },
            ],
            response_format: zodResponseFormat(RecoveryMessageSchema, "recovery_message"),
            temperature: AI_MESSAGE_TEMPERATURE,
        });

        const message = completion.choices[0]?.message?.parsed;
        if (!message) {
            throw new Error("Failed to parse recovery message");
        }
        return message;
    } catch (error) {
        console.error("AI message generation failed, using template:", error);
        return fallbackMessage(context);
    }
}

// ─── 3. Determine Next Action ───

export async function determineNextAction(context: {
    failureCategory: string;
    currentStep: number;
    maxSteps: number;
    previousActions: Array<{ actionType: string; status: string; channel?: string }>;
    amount: number;
    customerOptedOut: boolean;
    daysSinceFailure: number;
}): Promise<NextActionResult> {
    try {
        const completion = await openAIClient.chat.completions.parse({
            model: AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `You are an AI agent deciding the next recovery action for a failed payment.

Rules:
1. If customer has opted out (DND), set shouldStop = true
2. Never exceed maxSteps total actions
3. Escalate channels: email → SMS → WhatsApp → final email
4. Don't repeat the same channel twice in a row
5. If it's a soft decline, prioritize retry_payment first
6. If it's a hard decline, always send_payment_link
7. If amount < ₹100, consider no_action (not worth aggressive recovery)
8. After 7 days with no recovery, recommend stopping
9. Space actions at least 24h apart
10. Be empathetic — this is a real person

Previous actions taken:
${context.previousActions.map((a, i) => `  Step ${i + 1}: ${a.actionType} via ${a.channel || "N/A"} — ${a.status}`).join("\n")}`,
                },
                {
                    role: "user",
                    content: `What should we do next?
- Failure category: ${context.failureCategory}
- Current step: ${context.currentStep} of ${context.maxSteps}
- Amount at risk: ₹${context.amount / 100}
- Customer opted out: ${context.customerOptedOut}
- Days since failure: ${context.daysSinceFailure}`,
                },
            ],
            response_format: zodResponseFormat(NextActionSchema, "next_action"),
            temperature: AI_NEXT_ACTION_TEMPERATURE,
        });

        const result = completion.choices[0]?.message?.parsed;
        if (!result) {
            throw new Error("Failed to parse next action");
        }
        return result;
    } catch (error) {
        console.error("AI next action failed, using rule-based:", error);
        return fallbackNextAction(context);
    }
}

// ─── Fallbacks (when LLM fails) ───

function fallbackDiagnosis(context: {
    errorCode?: string;
    errorDescription?: string;
    amount: number;
    currency: string;
}): DiagnosisResult {
    const classification = classifyDeclineCode(context.errorCode, context.errorDescription);
    return {
        failureCategory: classification.category as DiagnosisResult["failureCategory"],
        rootCause: classification.description,
        isRetriable: classification.retriable,
        customerActionNeeded: classification.customerActionNeeded,
        urgency: classification.retriable ? "medium" : "high",
        recommendedAction: classification.retriable ? "retry_payment" : "send_payment_link",
        reasoning: `Rule-based fallback: ${classification.category}. AI service was unavailable.`,
    };
}

function fallbackMessage(context: {
    customerName?: string;
    amount: number;
    channel: string;
    escalationStep: number;
}): RecoveryMessage {
    const name = context.customerName || "there";
    const amount = `₹${context.amount / 100}`;

    if (context.channel === "sms") {
        return {
            subject: "",
            body: `Hi ${name}, your payment of ${amount} didn't go through. Please retry or update your payment method to continue your subscription.`,
            tone: context.escalationStep >= 3 ? "urgent" : "friendly",
            callToAction: "Update Payment",
        };
    }

    return {
        subject: context.escalationStep >= 3
            ? `Action needed: Your ${amount} payment requires attention`
            : `Quick update about your ${amount} payment`,
        body: `Hi ${name},\n\nWe noticed your recent payment of ${amount} didn't go through. This can happen for a number of reasons and is usually easy to fix.\n\nPlease click the link below to complete your payment and keep your subscription active.\n\nIf you've already resolved this, please disregard this message.`,
        tone: context.escalationStep >= 3 ? "urgent" : "friendly",
        callToAction: "Complete Payment",
    };
}

function fallbackNextAction(context: {
    failureCategory: string;
    currentStep: number;
    maxSteps: number;
    amount: number;
    customerOptedOut: boolean;
    daysSinceFailure: number;
}): NextActionResult {
    if (context.customerOptedOut) {
        return {
            action: "no_action",
            channel: null,
            reasoning: "Customer has opted out of communications",
            shouldStop: true,
            stopReason: "Customer DND",
            waitHours: 0,
        };
    }

    if (context.currentStep >= context.maxSteps) {
        return {
            action: "no_action",
            channel: null,
            reasoning: "Maximum recovery steps reached",
            shouldStop: true,
            stopReason: "Max steps exhausted",
            waitHours: 0,
        };
    }

    if (context.daysSinceFailure > MAX_RECOVERY_WINDOW_DAYS) {
        return {
            action: "no_action",
            channel: null,
            reasoning: `Recovery window expired (>${MAX_RECOVERY_WINDOW_DAYS} days)`,
            shouldStop: true,
            stopReason: "Time limit exceeded",
            waitHours: 0,
        };
    }

    // Simple escalation: email → sms → email → sms → email
    const channels: Array<"email" | "sms" | "whatsapp"> = ["email", "sms", "email", "whatsapp", "email"];
    const channel = channels[context.currentStep % channels.length] ?? null;

    return {
        action: context.failureCategory === "soft_decline" ? "retry_payment" : "send_email",
        channel,
        reasoning: `Rule-based: step ${context.currentStep + 1}, using ${channel}`,
        shouldStop: false,
        stopReason: null,
        waitHours: context.currentStep === 0 ? 0 : DEFAULT_WAIT_HOURS_BETWEEN_STEPS,
    };
}