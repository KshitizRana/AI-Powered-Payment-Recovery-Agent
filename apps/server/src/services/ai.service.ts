import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import config from "../config/config";
import { classifyDeclineCode, type FailureCategory, type ActionType, type NotificationChannel } from "@repo/shared";
import { AI_MODEL, MAX_RECOVERY_WINDOW_DAYS, DEFAULT_WAIT_HOURS_BETWEEN_STEPS, HIGH_VALUE_THRESHOLD_PAISE, AI_DIAGNOSIS_TEMPERATURE, AI_MESSAGE_TEMPERATURE, AI_NEXT_ACTION_TEMPERATURE } from "../constants/constants";

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
    waitHours: z.number().describe(
        "Suggested hours before the next action, for future reference — advisory only. " +
        "Today the cascade's actual timing (Day 0/1/3/5/7) is fixed by the system regardless of this value."
    ),
});

const AbandonmentSchema = z.object({
    reason: z.enum([
        "price_hesitation", "technical_issue", "distraction",
        "comparison_shopping", "trust_concern", "unknown",
    ]),
    confidence: z.enum(["low", "medium", "high"]),
    suggestedTone: z.enum(["reassuring", "urgent_scarcity", "helpful", "no_pressure"]),
    recommendedFollowUpMinutes: z.number().describe("Minutes to wait before the first follow-up message"),
    reasoning: z.string(),
});

// ─── Types ───

export type DiagnosisResult = z.infer<typeof DiagnosisSchema>;
export type RecoveryMessage = z.infer<typeof RecoveryMessageSchema>;
export type NextActionResult = z.infer<typeof NextActionSchema>;
export type AbandonmentClassification = z.infer<typeof AbandonmentSchema>;

export function deriveDisplayName(email?: string | null, fallback = "there"): string {
    if (!email) return fallback;
    const localPart = email.split("@")[0];
    if (!localPart) return fallback;
    const name = localPart.split(/[._\-+]/)[0];
    if (!name || name.length < 2) return fallback;
    return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

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

Your job is to analyze a failed payment and return:
1. failureCategory
2. Whether it's retriable or needs customer action
3. Urgency
4. The single best immediate action

Category guidance:
- soft_decline (insufficient_balance, bank_transaction_limit_exceeded, etc.): temporary —
  the same payment method will likely work later. Prefer retry_payment.
- hard_decline (card_expired, lost_or_stolen_card, card_not_supported, etc.): this
  payment method will never succeed again as-is. recommendedAction should be
  send_payment_link — the customer must switch payment methods.
- gateway_error / network_error: infrastructure issue, not the customer's fault. Prefer
  retry_payment; only recommend contacting the customer if this looks like it's repeating.
- checkout_abandoned: not applicable here — no failure occurred, the customer simply
  left mid-checkout. This function is only called for actual payment failures.

Urgency guidance (use these thresholds, don't guess):
- critical: hard decline AND amount ≥ ₹${HIGH_VALUE_THRESHOLD_PAISE / 100}, or 3+ previous attempts already failed
- high: any hard decline, or 2+ previous soft-decline attempts
- medium: first soft decline or gateway error
- low: first gateway error on a low-value payment

recommendedAction must be one of: retry_payment, send_payment_link, send_email,
send_sms, send_whatsapp, escalate, no_action.
- Use escalate only when previousAttempts is already 3+ and nothing has worked — it
  hands off to a human, so don't reach for it early.
- Use no_action only if something about this specific payment looks clearly
  non-recoverable (e.g. explicitly cancelled by the customer) — amount thresholds are
  handled elsewhere, so don't use no_action just because the amount seems small.

Context:
- Amount is in paise (divide by 100 for INR); respect the given currency code rather
  than assuming INR.
- Indian payment methods: UPI, cards, netbanking, wallets, EMI.

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
            // temperature: AI_DIAGNOSIS_TEMPERATURE,
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

// ─── 2. Generate Recovery Message ──
function resolveTone(escalationStep: number, maxSteps: number): string {
    const progress = maxSteps > 1 ? escalationStep / maxSteps : 1;
    if (progress <= 0.25) return "friendly and helpful";
    if (progress <= 0.5) return "gently urgent";
    if (progress <= 0.75) return "concerned but professional";
    if (progress < 1) return "increasingly urgent — one of the final attempts";
    return "final notice — respectful but clear this is the last attempt";
}

export async function generateRecoveryMessage(context: {
    customerName?: string;
    amount: number;
    currency: string;
    failureCategory: string;
    escalationStep: number;
    maxSteps: number;
    channel: string;
    productDescription?: string;
}): Promise<RecoveryMessage> {
    const tone = resolveTone(context.escalationStep, context.maxSteps);

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
- Use the customer's name only if it looks like a real name; if you're given something
  generic like "Valued Customer", write around it rather than using it awkwardly
- Tone should be: ${tone}
- This is escalation step ${context.escalationStep} of ${context.maxSteps} — write with
  that position in mind: an early step should feel like a helpful nudge, a late step
  should make clear this is close to the last outreach without sounding like a threat

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
- Escalation Step: ${context.escalationStep} of ${context.maxSteps}
- Product: ${context.productDescription || "your subscription"}`,
                },
            ],
            response_format: zodResponseFormat(RecoveryMessageSchema, "recovery_message"),
            // temperature: AI_MESSAGE_TEMPERATURE,
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
    preferredChannel?: "email" | "sms" | "whatsapp" | null; // [NEW]
}): Promise<NextActionResult> {
    try {
        const completion = await openAIClient.chat.completions.parse({
            model: AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `You are an AI agent deciding the next recovery action for a failed payment.

Hard constraints — never violate these regardless of anything else:
1. If customerOptedOut is true, set shouldStop = true and don't pick an action.
2. If currentStep >= maxSteps, stop.
3. If daysSinceFailure > ${MAX_RECOVERY_WINDOW_DAYS}, stop — this is a fixed cutoff, not
   a judgment call, even if the payment is high-value.
4. Amount thresholds are already enforced before you're called — don't recommend
   no_action just because the amount seems small.

Choosing the action:
- retry_payment: no customer-facing message. Choose this ONLY for the very first step (current step 1) of a soft_decline, gateway_error, or network_error. If the current step is > 1, DO NOT choose retry_payment again — it's time to contact the customer (send_email, send_sms, etc).
- send_payment_link: the customer must actively complete payment with a different
  method. Right choice for hard_decline. Note: for hard declines, a payment link is
  typically already sent once before this cascade even starts — if the previous action
  was already send_payment_link, prefer a reminder message (send_email/sms/whatsapp)
  over minting another link every single step.
- send_email / send_sms / send_whatsapp: a nudge or reminder, no fresh link required.
- escalate: hand off to a human. Reserve for high-value cases with at least 2-3 prior
  attempts that went nowhere — not a first-step option.
- no_action: only when nothing above is appropriate right now — should be rare.

Channel selection:
- Default progression across a cascade: email → SMS → email → WhatsApp → email.
- Never repeat the exact same channel as the immediately previous action.
- If preferredChannel (given below) is known and wasn't the immediately previous
  channel, prefer it over the default progression.
- If the previous action's status was "failed" (delivery failed), don't pick that same
  channel again — switch.

Previous actions taken:
${context.previousActions.length > 0
                            ? context.previousActions.map((a, i) => `  Step ${i + 1}: ${a.actionType} via ${a.channel || "N/A"} — ${a.status}`).join("\n")
                            : "  (none yet — this is the first action in the cascade)"}`,
                },
                {
                    role: "user",
                    content: `What should we do next?
- Failure category: ${context.failureCategory}
- Current step: ${context.currentStep} of ${context.maxSteps}
- Amount at risk: ₹${context.amount / 100}
- Customer opted out: ${context.customerOptedOut}
- Days since failure: ${context.daysSinceFailure}
- Customer's preferred channel: ${context.preferredChannel || "unknown"}`,
                },
            ],
            response_format: zodResponseFormat(NextActionSchema, "next_action"),
            // temperature: AI_NEXT_ACTION_TEMPERATURE,
        });

        const result = completion.choices[0]?.message?.parsed;
        if (!result) {
            throw new Error("Failed to parse next action");
        }

        if (context.daysSinceFailure > MAX_RECOVERY_WINDOW_DAYS && !result.shouldStop) {
            return {
                ...result,
                shouldStop: true,
                stopReason: `Hard cutoff: ${MAX_RECOVERY_WINDOW_DAYS}-day recovery window exceeded.`,
            };
        }
        if (result.action === "retry_payment" && context.currentStep > 1) {
            return {
                ...result,
                action: "send_email",
                channel: result.channel || "email",
                reasoning: `${result.reasoning} (overridden: retry_payment isn't allowed past step 1)`,
            };
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

    // Simple escalation: email → sms → email → whatsapp → email
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

export async function classifyAbandonment(context: {
    amount: number;
    currency: string;
    method?: string;
    minutesOnCheckout?: number;
    previousAbandonments?: number;
}): Promise<AbandonmentClassification> {
    try {
        const completion = await openAIClient.chat.completions.parse({
            model: AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `You are analyzing why an Indian e-commerce customer abandoned checkout before completing payment.

Signals to weigh:
- Higher amounts + no previous abandonments → often price_hesitation
- Repeated abandonments on the same account → often comparison_shopping or trust_concern
- Very short time on checkout (<30s) before leaving → often technical_issue or distraction
- UPI/netbanking abandons are frequently technical_issue (app switching, OTP delays)

Recommend a follow-up delay: aggressive (10-15 min) for likely technical_issue or distraction
(they may just come back), gentler (60-120 min) for price_hesitation or trust_concern
(give them space, don't feel pushy).`,
                },
                {
                    role: "user",
                    content: `Classify this abandoned checkout:
- Amount: ₹${context.amount / 100} (${context.currency})
- Payment method attempted: ${context.method || "unknown"}
- Time spent on checkout: ${context.minutesOnCheckout ?? "unknown"} minutes
- Previous abandonments by this customer: ${context.previousAbandonments ?? 0}`,
                },
            ],
            response_format: zodResponseFormat(AbandonmentSchema, "abandonment"),
            // temperature: 0.3,
        });

        const result = completion.choices[0]?.message?.parsed;
        if (!result) throw new Error("Failed to parse abandonment classification");
        return result;
    } catch (error) {
        console.error("AI abandonment classification failed, using fallback:", error);
        return {
            reason: "unknown",
            confidence: "low",
            suggestedTone: "helpful",
            recommendedFollowUpMinutes: 60,
            reasoning: "Rule-based fallback: AI service was unavailable.",
        };
    }
}