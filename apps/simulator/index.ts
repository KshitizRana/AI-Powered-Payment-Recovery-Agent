import dotenv from "dotenv";

dotenv.config();
import { SOFT_DECLINES, HARD_DECLINES, randomEmail, randomAmount, randomName } from "./data";

const API = process.env.SERVER_URL || "http://localhost:8080";

interface Result {
    type: string;
    email: string;
    amount: number;
    status: "sent" | "failed";
}

async function simulate(payload: Record<string, any>): Promise<any> {
    try {
        const res = await fetch(`${API}/api/v1/simulate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (error) {
        console.error("Request failed:", error);
        return null;
    }
}

// Small delay between sends — firing 80 events in a tight loop means 80
// near-simultaneous OpenAI calls in the first Inngest step of each run
// (diagnoseFailure). Staggering avoids hammering the rate limit and mirrors
// how failures actually arrive in the real world anyway — not all at once.
function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const results: Result[] = [];
    let sent = 0;
    let failed = 0;

    console.log("=== Batch Simulation Starting ===\n");

    // 50 failed subscriptions — mixed soft/hard decline, ~70/30 split
    console.log("Generating 50 failed subscriptions...");
    for (let i = 0; i < 50; i++) {
        const isHard = Math.random() < 0.3;
        const pool = isHard ? HARD_DECLINES : SOFT_DECLINES;
        const decline = pool[Math.floor(Math.random() * pool.length)];
        const email = randomEmail(i);
        const amount = randomAmount();

        const res = await simulate({
            type: isHard ? "subscription_hard_decline" : "subscription_soft_decline",
            email,
            amount,
            declineCode: decline.code,
            errorDescription: decline.description,
        });

        const ok = res !== null;
        ok ? sent++ : failed++;
        results.push({ type: isHard ? "hard_decline" : "soft_decline", email, amount, status: ok ? "sent" : "failed" });

        // Self-resolve ~40% of successful events to make the mix look organic
        if (ok && Math.random() < 0.4) {
            setTimeout(() => {
                simulate({ type: "subscription_recovered", subscriptionId: res.subscriptionId });
            }, (5 + Math.random() * 20) * 1000); // resolves 5–25s later
        }

        if (i % 10 === 0) console.log(`  ${i}/50...`);
        await sleep(300);
    }

    console.log("\nGenerating 30 abandoned checkouts...");
    for (let i = 0; i < 30; i++) {
        const email = randomEmail(i + 50);
        const amount = randomAmount();

        const res = await simulate({
            type: "checkout_abandoned",
            email,
            amount,
            method: Math.random() < 0.6 ? "upi" : "card",
        });

        const ok = res !== null;
        ok ? sent++ : failed++;
        results.push({ type: "checkout_abandoned", email, amount, status: ok ? "sent" : "failed" });

        // Self-resolve ~40% of successful events to make the mix look organic
        if (ok && Math.random() < 0.4) {
            setTimeout(() => {
                simulate({ type: "checkout_recovered", orderId: res.orderId });
            }, (5 + Math.random() * 20) * 1000); // resolves 5–25s later
        }

        if (i % 10 === 0) console.log(`  ${i}/30...`);
        await sleep(300);
    }

    console.log(`\n=== Batch Complete: ${sent} sent, ${failed} failed ===`);
    console.log("\nRun `bun run report` in a few minutes once the cascades have had time to process the first step or two.");
}

main().catch(console.error);