const API = process.env.SERVER_URL || "http://localhost:8080";

async function main() {
    const res = await fetch(`${API}/api/v1/recovery/metrics`);
    const metrics = await res.json();

    const recoveredInr = (metrics.totalRecoveredPaise / 100).toLocaleString("en-IN");
    const atRiskInr = (metrics.totalAtRiskPaise / 100).toLocaleString("en-IN");

    console.log("\n" + "=".repeat(50));
    console.log(`  ₹${recoveredInr} recovered from ${metrics.statusBreakdown?.recovered || 0} attempts`);
    console.log("=".repeat(50));
    console.log(`  Total at risk:        ₹${atRiskInr}`);
    console.log(`  Recovery rate:        ${metrics.recoveryRate}%`);
    console.log(`  Active workflows:     ${metrics.activeWorkflows}`);
    console.log(`  Notifications sent:   ${metrics.totalNotificationsSent}`);
    console.log(`  Status breakdown:`);
    for (const [status, count] of Object.entries(metrics.statusBreakdown || {})) {
        console.log(`    ${status.padEnd(20)} ${count}`);
    }
    console.log("=".repeat(50) + "\n");
}

main().catch(console.error);