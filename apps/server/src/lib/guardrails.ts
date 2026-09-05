import { db, customers, recoveryAttempts, eq, and, gte } from "@repo/db";
import { getCustomerGuardrailContext } from "../services/customer.service";
import { RECOVERY_CONFIG } from "@repo/shared";

export interface GuardrailCheck {
    allowed: boolean;
    reason?: string;
}

interface GuardrailResult {
    allowed: boolean;
    reason?: string;
    preferredChannel?: "email" | "sms" | "whatsapp" | null;
}

// ── 1. DND / Opt-out check ──
// export async function checkDND(customerId?: string): Promise<GuardrailCheck> {
//     if (!customerId) return { allowed: true };

//     const [customer] = await db
//         .select({ optedOut: customers.optedOut })
//         .from(customers)
//         .where(eq(customers.id, customerId))
//         .limit(1);

//     if (customer?.optedOut) {
//         return { allowed: false, reason: "Customer has opted out of recovery communications" };
//     }

//     return { allowed: true };
// }

// ── 2. Max attempts per customer in a time window ──
// export async function checkContactFrequency(
//     customerId: string,
//     windowHours: number = 24,
//     maxContacts: number = 2
// ): Promise<GuardrailCheck> {
//     const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

//     const recentAttempts = await db
//         .select()
//         .from(recoveryAttempts)
//         .where(
//             and(
//                 eq(recoveryAttempts.customerId, customerId),
//                 gte(recoveryAttempts.createdAt, windowStart)
//             )
//         );

//     if (recentAttempts.length >= maxContacts) {
//         return {
//             allowed: false,
//             reason: `Customer contacted ${recentAttempts.length} times in last ${windowHours}h (limit: ${maxContacts})`,
//         };
//     }

//     return { allowed: true };
// }

// ── 3. Amount threshold check ──
// export function checkAmountThreshold(amountPaise: number, minAmountPaise: number = 10000): GuardrailCheck {
//     if (amountPaise < minAmountPaise) {
//         return {
//             allowed: false,
//             reason: `Amount ₹${amountPaise / 100} is below minimum recovery threshold ₹${minAmountPaise / 100}`,
//         };
//     }
//     return { allowed: true };
// }

// ── 4. Validate AI output ──
// export function validateAIOutput(output: any, expectedFields: string[]): GuardrailCheck {
//     for (const field of expectedFields) {
//         if (output[field] === undefined || output[field] === null) {
//             return {
//                 allowed: false,
//                 reason: `AI output missing required field: ${field}`,
//             };
//         }
//     }
//     return { allowed: true };
// }

// ── 5. Run all pre-action guardrails ──
// export async function runPreActionGuardrails(context: {
//     customerId?: string;
//     amountPaise: number;
// }): Promise<GuardrailCheck> {
//     // Check amount threshold
//     const amountCheck = checkAmountThreshold(context.amountPaise);
//     if (!amountCheck.allowed) return amountCheck;

//     // Check DND
//     if (context.customerId) {
//         const dndCheck = await checkDND(context.customerId);
//         if (!dndCheck.allowed) return dndCheck;

//         // Check contact frequency
//         const frequencyCheck = await checkContactFrequency(context.customerId);
//         if (!frequencyCheck.allowed) return frequencyCheck;
//     }

//     return { allowed: true };
// }

const MIN_CONTACT_GAP_HOURS = 20; // slightly under 24h so a 24h-cadence step never blocks on its own cadence
const ENFORCE_CONTACT_GAP = process.env.SKIP_CONTACT_GAP_GUARDRAIL !== "true";

export async function runPreActionGuardrails(params: {
    customerId?: string;
    amountPaise: number;
}): Promise<GuardrailResult> {
    // Cheap check first, no DB hit
    if (params.amountPaise < RECOVERY_CONFIG.MIN_RECOVERY_AMOUNT_PAISE) {
        return { allowed: false, reason: `Amount ₹${params.amountPaise / 100} below recovery threshold` };
    }

    // Guest/anonymous checkouts have no customerId yet — nothing to check against
    if (!params.customerId) {
        return { allowed: true };
    }

    const customer = await getCustomerGuardrailContext(params.customerId);

    if (!customer) {
        // customerId was passed but doesn't resolve — fail open rather than
        // silently blocking a legitimate recovery over a data issue
        return { allowed: true };
    }

    if (customer.optedOut) {
        return { allowed: false, reason: "Customer has opted out (DND)" };
    }

    if (customer.lastContactedAt) {
        const hoursSinceLastContact = (Date.now() - customer.lastContactedAt.getTime()) / (1000 * 60 * 60);
        const effectiveMinGap = process.env.FAST_DEMO_MODE === "true" ? 0 : MIN_CONTACT_GAP_HOURS;
        if (hoursSinceLastContact < effectiveMinGap) {
            if (!ENFORCE_CONTACT_GAP) {
                console.warn(
                    `[guardrail bypass] SKIP_CONTACT_GAP_GUARDRAIL=true — would have blocked ` +
                    `(${hoursSinceLastContact.toFixed(1)}h since last contact, min is ${MIN_CONTACT_GAP_HOURS}h)`
                );
            } else {
                return {
                    allowed: false,
                    reason: `Contacted ${hoursSinceLastContact.toFixed(1)}h ago — under the ${MIN_CONTACT_GAP_HOURS}h minimum gap`,
                };
            }
        }
    }

    return { allowed: true, preferredChannel: customer.preferredChannel };
}

