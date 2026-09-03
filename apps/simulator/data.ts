export const SOFT_DECLINES = [
    { code: "insufficient_balance", description: "Payment failed due to insufficient balance" },
    { code: "bank_transaction_limit_exceeded", description: "Transaction limit exceeded for the day" },
];

export const HARD_DECLINES = [
    { code: "card_expired", description: "Card has expired" },
    { code: "lost_or_stolen_card", description: "Card reported lost or stolen" },
    { code: "card_not_supported", description: "Card type not supported for recurring payments" },
];

export const GATEWAY_ERRORS = [
    { code: "gateway_error", description: "Payment gateway timed out" },
    { code: "network_error", description: "Network error during payment processing" },
];

const FIRST_NAMES = ["Aarav", "Priya", "Rohan", "Ananya", "Vikram", "Neha", "Karan", "Divya", "Arjun", "Sneha"];
const LAST_NAMES = ["Sharma", "Patel", "Kumar", "Singh", "Reddy", "Nair", "Iyer", "Gupta", "Rao", "Menon"];

export function randomName(): string {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    return `${first} ${last}`;
}

export function randomEmail(index: number): string {
    const name = randomName().toLowerCase().replace(" ", ".");
    return `${name}.${index}@demo-test.com`;
}

// Weighted amount pool — mostly ordinary SaaS pricing, with a deliberate few
// at the extremes so the demo shows the guardrail-blocks and
// escalated-to-human branches too, not just the middle-of-the-road cases.
export function randomAmount(): number {
    const roll = Math.random();
    if (roll < 0.05) return Math.floor(Math.random() * 5000) + 1000;       // ~5%: below typical MIN_RECOVERY_AMOUNT_PAISE — should get guardrail-blocked
    if (roll < 0.15) return Math.floor(Math.random() * 300000) + 500000;   // ~10%: high value (≥ ₹5,000) — should escalate-to-human if unrecovered
    return Math.floor(Math.random() * 970000) + 29900;                     // rest: ₹299–₹9,999, ordinary range
}