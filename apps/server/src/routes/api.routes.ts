import { Hono } from "hono";
import { db, recoveryAttempts, recoveryActions, auditLogs, customers, notifications } from "@repo/db";
import { eq, sql, desc, and, count, sum } from "@repo/db";
import { inngest } from "../inngest/client";
import { upsertCustomer } from "../services/customer.service";

export const apiRoutes = new Hono();
apiRoutes.get("/recovery/metrics", async (c) => {
    try {
        // 1. Total ₹ at risk (across every recovery attempt ever created)
        const [atRisk] = await db
            .select({ total: sum(recoveryAttempts.amountAtRisk) })
            .from(recoveryAttempts);

        // 2. Total ₹ recovered (only rows that actually reached "recovered")
        const [recovered] = await db
            .select({ total: sum(recoveryAttempts.amountRecovered) })
            .from(recoveryAttempts)
            .where(eq(recoveryAttempts.status, "recovered"));

        // 3. Active workflows (everything that's still running)
        const [active] = await db
            .select({ count: count() })
            .from(recoveryAttempts)
            .where(
                sql`${recoveryAttempts.status} NOT IN ('recovered', 'abandoned', 'escalated')`
            );

        // 4. Recovery rate — only count completed workflows (recovered + abandoned + escalated)
        //    so the rate reflects decisions made, not in-progress runs. Note: escalated
        //    counts toward the denominator but not the numerator here — a case handed
        //    to a human isn't a failure, but it isn't a self-serve recovery either.
        //    Adjust if you'd rather treat escalated as a partial success.
        const [completed] = await db
            .select({ count: count() })
            .from(recoveryAttempts)
            .where(
                sql`${recoveryAttempts.status} IN ('recovered', 'abandoned', 'escalated')`
            );
        const [successes] = await db
            .select({ count: count() })
            .from(recoveryAttempts)
            .where(eq(recoveryAttempts.status, "recovered"));

        const completedCount = Number(completed?.count ?? 0);
        const successCount = Number(successes?.count ?? 0);
        const rate = completedCount > 0 ? ((successCount / completedCount) * 100) : 0;

        // 5. Status breakdown — for the dashboard's status distribution chart
        const breakdown = await db
            .select({
                status: recoveryAttempts.status,
                count: count(),
            })
            .from(recoveryAttempts)
            .groupBy(recoveryAttempts.status);

        // 6. Total notifications sent
        // api.routes.ts, metrics endpoint
        const [notifCount] = await db
            .select({ count: count() })
            .from(notifications)
            .where(sql`${notifications.status} IN ('sent', 'queued', 'delivered')`);

        return c.json({
            totalAtRiskPaise: Number(atRisk?.total ?? 0),
            totalRecoveredPaise: Number(recovered?.total ?? 0),
            activeWorkflows: Number(active?.count ?? 0),
            recoveryRate: Math.round(rate * 10) / 10,    // one decimal
            totalNotificationsSent: Number(notifCount?.count ?? 0),
            statusBreakdown: breakdown.reduce((acc, row) => {
                acc[row.status] = Number(row.count);
                return acc;
            }, {} as Record<string, number>),
        });
    } catch (error) {
        console.error("GET /api/recovery/metrics error:", error);
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

// ─── GET /api/recovery/list ───

apiRoutes.get("/recovery/list", async (c) => {
    try {
        const page = Math.max(1, Number(c.req.query("page") || "1"));
        const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") || "20")));
        const offset = (page - 1) * limit;

        const statusFilter = c.req.query("status");   // e.g. ?status=recovered
        const typeFilter = c.req.query("type");        // e.g. ?type=subscription_renewal

        // Build WHERE conditions
        const conditions = [];
        if (statusFilter) {
            conditions.push(eq(recoveryAttempts.status, statusFilter as any));
        }
        if (typeFilter) {
            conditions.push(eq(recoveryAttempts.type, typeFilter as any));
        }

        const whereClause = conditions.length > 0
            ? conditions.length === 1 ? conditions[0] : and(...conditions)
            : undefined;

        // Data
        const data = await db
            .select({
                id: recoveryAttempts.id,
                type: recoveryAttempts.type,
                razorpayEntityId: recoveryAttempts.razorpayEntityId,
                status: recoveryAttempts.status,
                failureCategory: recoveryAttempts.failureCategory,
                declineCode: recoveryAttempts.declineCode,
                amountAtRisk: recoveryAttempts.amountAtRisk,
                amountRecovered: recoveryAttempts.amountRecovered,
                currency: recoveryAttempts.currency,
                currentStep: recoveryAttempts.currentStep,
                maxSteps: recoveryAttempts.maxSteps,
                createdAt: recoveryAttempts.createdAt,
                recoveredAt: recoveryAttempts.recoveredAt,
                abandonedAt: recoveryAttempts.abandonedAt,
                // Customer join
                customerEmail: customers.email,
                customerPhone: customers.phone,
            })
            .from(recoveryAttempts)
            .leftJoin(customers, eq(recoveryAttempts.customerId, customers.id))
            .where(whereClause)
            .orderBy(desc(recoveryAttempts.createdAt))
            .limit(limit)
            .offset(offset);

        // Total count (for pagination)
        const [totalResult] = await db
            .select({ count: count() })
            .from(recoveryAttempts)
            .where(whereClause);

        const total = Number(totalResult?.count ?? 0);

        return c.json({
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("GET /api/recovery/list error:", error);
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

// ─── GET /api/recovery/:id ───

apiRoutes.get("/recovery/:id", async (c) => {
    try {
        const id = c.req.param("id");

        // 1. Core recovery attempt
        const [recovery] = await db
            .select()
            .from(recoveryAttempts)
            .where(eq(recoveryAttempts.id, id))
            .limit(1);

        if (!recovery) {
            return c.json({ error: "Recovery attempt not found" }, 404);
        }

        // 2. Customer (if attached)
        let customer = null;
        if (recovery.customerId) {
            const [c] = await db
                .select()
                .from(customers)
                .where(eq(customers.id, recovery.customerId))
                .limit(1);
            customer = c ?? null;
        }

        // 3. AI actions taken — ordered by step
        const actions = await db
            .select()
            .from(recoveryActions)
            .where(eq(recoveryActions.recoveryAttemptId, id))
            .orderBy(recoveryActions.stepNumber);

        // 4. Audit trail — newest first, so the timeline reads top-down as "what just happened"
        const logs = await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.recoveryAttemptId, id))
            .orderBy(desc(auditLogs.createdAt));

        // 5. Notifications sent for this recovery
        const notifs = await db
            .select()
            .from(notifications)
            .where(eq(notifications.recoveryAttemptId, id))
            .orderBy(desc(notifications.createdAt));

        return c.json({
            recovery,
            customer,
            actions,
            notifications: notifs,
            timeline: logs,
        });
    } catch (error) {
        console.error(`GET /api/recovery/${c.req.param("id")} error:`, error);
        return c.json({ error: "Internal Server Error" }, 500);
    }
});

// ─── POST /api/simulate ───

apiRoutes.post("/simulate", async (c) => {
    try {
        const body = await c.req.json();
        const { type } = body;
        const email = body.email || "demo@example.com";

        switch (type) {
            case "subscription_soft_decline": {
                const subId = `sub_sim_${Date.now()}`;
                const customer = await upsertCustomer({ // [FIX] was missing — customerId was always undefined
                    razorpayCustomerId: `cust_sim_${Date.now()}`,
                    email,
                });
                await inngest.send({
                    name: "payment/subscription.failed",
                    data: {
                        subscriptionId: subId,
                        customerId: customer?.id,
                        customerEmail: email,
                        amount: body.amount || 99900,
                        currency: "INR",
                        declineCode: "insufficient_balance",
                        errorDescription: "Payment failed due to insufficient balance",
                        failedAt: new Date().toISOString(),
                    },
                });
                return c.json({ status: "sent", subscriptionId: subId });
            }

            case "subscription_hard_decline": {
                const subId = `sub_sim_${Date.now()}`;
                const customer = await upsertCustomer({ // [FIX]
                    razorpayCustomerId: `cust_sim_${Date.now()}`,
                    email,
                });
                await inngest.send({
                    name: "payment/subscription.failed",
                    data: {
                        subscriptionId: subId,
                        customerId: customer?.id,
                        customerEmail: email,
                        amount: body.amount || 149900,
                        currency: "INR",
                        declineCode: "card_expired",
                        errorDescription: "Card has expired",
                        failedAt: new Date().toISOString(),
                    },
                });
                return c.json({ status: "sent", subscriptionId: subId });
            }

            case "checkout_abandoned": {
                const orderId = `order_sim_${Date.now()}`;
                // Checkout is often a guest flow, so a customer record here is
                // optional in real life — but for demo purposes, wiring it up
                // means the dashboard shows a real email instead of a blank customer.
                const customer = await upsertCustomer({ // [FIX]
                    razorpayCustomerId: `cust_sim_${Date.now()}`,
                    email,
                });
                await inngest.send({
                    name: "payment/checkout.abandoned",
                    data: {
                        orderId,
                        customerId: customer?.id,
                        customerEmail: email,
                        amount: body.amount || 249900,
                        currency: "INR",
                        method: body.method || "upi",
                        abandonedAt: new Date().toISOString(),
                    },
                });
                return c.json({ status: "sent", orderId });
            }

            case "subscription_recovered": {
                await inngest.send({
                    name: "payment/subscription.recovered",
                    data: {
                        subscriptionId: body.subscriptionId,
                        recoveredAt: new Date().toISOString(),
                    },
                });
                return c.json({ status: "sent" });
            }

            default:
                return c.json({ error: `Unknown simulation type: ${type}` }, 400);
        }
    } catch (error) {
        console.error("POST /api/simulate error:", error);
        return c.json({ error: "Internal Server Error" }, 500);
    }
});