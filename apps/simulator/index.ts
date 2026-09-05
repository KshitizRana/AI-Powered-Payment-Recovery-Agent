import dotenv from "dotenv";
dotenv.config();

const API = process.env.SERVER_URL || "http://localhost:8080";

// ─── Helper ────────────────────────────────────────────────────────────────────
async function simulate(payload: Record<string, any>): Promise<any> {
    try {
        const res = await fetch(`${API}/api/v1/simulate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const text = await res.text();
            console.error(`  ✗ HTTP ${res.status}: ${text.slice(0, 120)}`);
            return null;
        }
        return await res.json();
    } catch (error) {
        console.error("  ✗ Request failed:", error);
        return null;
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Curated Scenarios ─────────────────────────────────────────────────────────
//
// Why a simulator instead of Razorpay directly?
// Razorpay test mode auto-retries every "failed" charge within seconds and
// typically succeeds — so a real webhook failure gets immediately overwritten
// by a success before our cascade can even start. The simulator fires the exact
// Inngest events our production webhook handler would fire, letting us observe
// the full 5-step or 2-step cascade without race conditions.
//
// Each scenario below is designed to run its FULL cascade:
//  • Subscription (5-step): runs all 5 AI decisions, no self-resolve, so the
//    dashboard shows step 1/5 → 2/5 → ... → 5/5 → abandoned (or escalated).
//  • Checkout (2-step): runs both emails, so 2/2 is visible.
//  • "Recovered" variants: self-resolve fires ~20 s after the failure so the
//    dashboard shows the cancel-on-payment path working live.
//  • Guardrail-blocked: amount below threshold, so the cascade is stopped at
//    the door and appears as abandoned with reason in the audit trail.
//
interface Scenario {
    label: string;
    type: string;
    email: string;
    amount: number;
    declineCode?: string;
    errorDescription?: string;
    method?: string;
    selfResolve?: boolean;
    resolveDelay?: number;
}

const SCENARIOS: Scenario[] = [
    // ── Subscription failures ──────────────────────────────────────────────
    {
        label: "Sub: Soft decline (insufficient balance) — full 5-step cascade",
        type: "subscription_soft_decline",
        email: "priya.sharma@demo-test.com",
        amount: 99900,      // Rs 999 — ordinary SaaS tier
        declineCode: "insufficient_balance",
        errorDescription: "Payment failed due to insufficient balance",
        selfResolve: false,
    },
    {
        label: "Sub: Hard decline (expired card) — full 5-step cascade",
        type: "subscription_hard_decline",
        email: "rohan.patel@demo-test.com",
        amount: 249900,     // Rs 2,499
        declineCode: "card_expired",
        errorDescription: "Card has expired",
        selfResolve: false,
    },
    {
        label: "Sub: Soft decline — recovers after Step 1 (shows cancelOn working)",
        type: "subscription_soft_decline",
        email: "ananya.kumar@demo-test.com",
        amount: 49900,      // Rs 499
        declineCode: "bank_transaction_limit_exceeded",
        errorDescription: "Transaction limit exceeded for the day",
        selfResolve: true,
        resolveDelay: 22000,  // 22 s — fires after first email, before step 2
    },
    {
        label: "Sub: High value (Rs 7,500) — should escalate to human if unrecovered",
        type: "subscription_hard_decline",
        email: "vikram.singh@demo-test.com",
        amount: 750000,     // Rs 7,500
        declineCode: "lost_or_stolen_card",
        errorDescription: "Card reported lost or stolen",
        selfResolve: false,
    },
    {
        label: "Sub: Guardrail blocked — amount below threshold (Rs 30)",
        type: "subscription_soft_decline",
        email: "neha.reddy@demo-test.com",
        amount: 3000,       // Rs 30 — below MIN_RECOVERY_AMOUNT_PAISE, guardrail fires
        declineCode: "insufficient_balance",
        errorDescription: "Payment failed due to insufficient balance",
        selfResolve: false,
    },
    // ── Checkout abandonment ───────────────────────────────────────────────
    {
        label: "Checkout: UPI abandoned — full 2-step cascade",
        type: "checkout_abandoned",
        email: "karan.iyer@demo-test.com",
        amount: 199900,     // Rs 1,999
        method: "upi",
        selfResolve: false,
    },
    {
        label: "Checkout: Card abandoned — recovers after Step 1",
        type: "checkout_abandoned",
        email: "divya.gupta@demo-test.com",
        amount: 99900,      // Rs 999
        method: "card",
        selfResolve: true,
        resolveDelay: 20000,  // 20 s
    },
    {
        label: "Checkout: Guardrail blocked — amount below threshold (Rs 25)",
        type: "checkout_abandoned",
        email: "arjun.rao@demo-test.com",
        amount: 2500,       // Rs 25 — guardrail fires
        method: "upi",
        selfResolve: false,
    },
];

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n=== Demo Batch: 8 curated scenarios ===");
    console.log("Each one is designed to run its full cascade (5/5 or 2/2).\n");

    for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];
        console.log(`[${i + 1}/${SCENARIOS.length}] ${s.label}`);

        const payload: Record<string, any> = {
            type: s.type,
            email: s.email,
            amount: s.amount,
        };
        if (s.declineCode)      payload.declineCode = s.declineCode;
        if (s.errorDescription) payload.errorDescription = s.errorDescription;
        if (s.method)           payload.method = s.method;

        const res = await simulate(payload);

        if (res) {
            console.log(`  ✓ Queued — id: ${res.subscriptionId ?? res.orderId ?? "?"}`);

            // Schedule self-resolution for "recovers" scenarios
            if (s.selfResolve) {
                const delay = s.resolveDelay ?? 20000;
                const capturedRes = res;
                const capturedType = s.type;
                setTimeout(async () => {
                    const resolveType = capturedType.startsWith("subscription")
                        ? "subscription_recovered"
                        : "checkout_recovered";
                    const resolvePayload = capturedType.startsWith("subscription")
                        ? { type: resolveType, subscriptionId: capturedRes.subscriptionId }
                        : { type: resolveType, orderId: capturedRes.orderId };
                    await simulate(resolvePayload);
                    console.log(`  -> [${i + 1}] Self-resolved (${resolveType})`);
                }, delay);
            }
        } else {
            console.log("  ✗ Failed — is the server running on", API, "?");
        }

        // Stagger by 1 s between scenarios so Inngest and the AI are not hit simultaneously
        await sleep(1000);
    }

    console.log("\n=== All 8 scenarios queued ===");
    console.log("Watch Inngest at http://localhost:8288");
    console.log("Then run: bun run report\n");
}

main().catch(console.error);