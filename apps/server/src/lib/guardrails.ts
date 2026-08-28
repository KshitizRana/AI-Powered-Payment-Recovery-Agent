import { db, customers, recoveryAttempts } from "@repo/db";
import { eq, and, gte } from "@repo/db";

export interface GuardrailCheck {
    allowed: boolean;
    reason?: string;
}

// ── 1. DND / Opt-out check ──
export async function checkDND(customerId?: string): Promise<GuardrailCheck> {
    if (!customerId) return { allowed: true };

    const [customer] = await db
        .select({ optedOut: customers.optedOut })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);

    if (customer?.optedOut) {
        return { allowed: false, reason: "Customer has opted out of recovery communications" };
    }

    return { allowed: true };
}

// ── 2. Max attempts per customer in a time window ──
export async function checkContactFrequency(
    customerId: string,
    windowHours: number = 24,
    maxContacts: number = 2
): Promise<GuardrailCheck> {
    const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const recentAttempts = await db
        .select()
        .from(recoveryAttempts)
        .where(
            and(
                eq(recoveryAttempts.customerId, customerId),
                gte(recoveryAttempts.createdAt, windowStart)
            )
        );

    if (recentAttempts.length >= maxContacts) {
        return {
            allowed: false,
            reason: `Customer contacted ${recentAttempts.length} times in last ${windowHours}h (limit: ${maxContacts})`,
        };
    }

    return { allowed: true };
}

// ── 3. Amount threshold check ──
export function checkAmountThreshold(amountPaise: number, minAmountPaise: number = 10000): GuardrailCheck {
    if (amountPaise < minAmountPaise) {
        return {
            allowed: false,
            reason: `Amount ₹${amountPaise / 100} is below minimum recovery threshold ₹${minAmountPaise / 100}`,
        };
    }
    return { allowed: true };
}

// ── 4. Validate AI output ──
export function validateAIOutput(output: any, expectedFields: string[]): GuardrailCheck {
    for (const field of expectedFields) {
        if (output[field] === undefined || output[field] === null) {
            return {
                allowed: false,
                reason: `AI output missing required field: ${field}`,
            };
        }
    }
    return { allowed: true };
}

// ── 5. Run all pre-action guardrails ──
export async function runPreActionGuardrails(context: {
    customerId?: string;
    amountPaise: number;
}): Promise<GuardrailCheck> {
    // Check amount threshold
    const amountCheck = checkAmountThreshold(context.amountPaise);
    if (!amountCheck.allowed) return amountCheck;

    // Check DND
    if (context.customerId) {
        const dndCheck = await checkDND(context.customerId);
        if (!dndCheck.allowed) return dndCheck;

        // Check contact frequency
        const frequencyCheck = await checkContactFrequency(context.customerId);
        if (!frequencyCheck.allowed) return frequencyCheck;
    }

    return { allowed: true };
}