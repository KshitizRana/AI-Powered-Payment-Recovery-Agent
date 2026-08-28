import { diagnoseFailure, generateRecoveryMessage, determineNextAction } from "../services/ai.service";

async function main() {
    console.log("─── Testing AI Diagnosis ───");
    const diagnosis = await diagnoseFailure({
        errorCode: "BAD_REQUEST_ERROR",
        errorDescription: "Payment failed due to insufficient balance",
        errorReason: "insufficient_balance",
        paymentMethod: "upi",
        amount: 99900,
        currency: "INR",
    });
    console.log(JSON.stringify(diagnosis, null, 2));

    console.log("\n─── Testing Recovery Message ───");
    const message = await generateRecoveryMessage({
        customerName: "Kshitiz",
        amount: 99900,
        currency: "INR",
        failureCategory: diagnosis.failureCategory,
        escalationStep: 1,
        channel: "email",
        productDescription: "Monthly Pro Plan",
    });
    console.log(JSON.stringify(message, null, 2));

    console.log("\n─── Testing Next Action ───");
    const nextAction = await determineNextAction({
        failureCategory: diagnosis.failureCategory,
        currentStep: 1,
        maxSteps: 5,
        previousActions: [
            { actionType: "send_email", status: "sent", channel: "email" },
        ],
        amount: 99900,
        customerOptedOut: false,
        daysSinceFailure: 2,
    });
    console.log(JSON.stringify(nextAction, null, 2));
}

main().catch(console.error);
