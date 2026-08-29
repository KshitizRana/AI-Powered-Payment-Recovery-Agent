import { db, customers, eq, sql } from "@repo/db";

export async function upsertCustomer(params: {
    razorpayCustomerId?: string;
    email?: string;
    phone?: string;
    name?: string;
}) {
    if (!params.razorpayCustomerId) return null;

    const [existing] = await db
        .select()
        .from(customers)
        .where(eq(customers.razorpayCustomerId, params.razorpayCustomerId))
        .limit(1);

    if (existing) {
        const [updated] = await db
            .update(customers)
            .set({
                email: params.email || existing.email,
                phone: params.phone || existing.phone,
                name: params.name || existing.name,
                updatedAt: new Date(),
            })
            .where(eq(customers.id, existing.id))
            .returning();
        return updated;
    }

    const [created] = await db
        .insert(customers)
        .values({
            razorpayCustomerId: params.razorpayCustomerId,
            email: params.email,
            phone: params.phone,
            name: params.name,
        })
        .returning();

    return created;
}

// ─── Recovery intelligence — call these from the Inngest functions ───

/** Call once when a new recovery_attempts row is created for this customer. */
export async function incrementRecoveryAttempts(customerId: string) {
    await db
        .update(customers)
        .set({ totalRecoveryAttempts: sql`${customers.totalRecoveryAttempts} + 1` })
        .where(eq(customers.id, customerId));
}

/** Call whenever an action actually reaches the customer (email/sms/whatsapp sent). */
export async function markCustomerContacted(customerId: string) {
    await db
        .update(customers)
        .set({ lastContactedAt: new Date() })
        .where(eq(customers.id, customerId));
}

/** Call whenever a recovery_attempts row flips to "recovered". */
export async function markCustomerRecovered(customerId: string) {
    await db
        .update(customers)
        .set({ successfulRecoveries: sql`${customers.successfulRecoveries} + 1` })
        .where(eq(customers.id, customerId));
}

/**
 * One round trip for everything guardrails.ts needs — replaces the separate
 * DND + contact-frequency queries from Day 3 with a single SELECT.
 */
export async function getCustomerGuardrailContext(customerId: string) {
    const [customer] = await db
        .select({
            optedOut: customers.optedOut,
            lastContactedAt: customers.lastContactedAt,
            preferredChannel: customers.preferredChannel,
        })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1);

    return customer ?? null;
}