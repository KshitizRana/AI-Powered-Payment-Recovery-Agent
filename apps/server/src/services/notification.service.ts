import Mailgen from "mailgen";
import nodemailer from "nodemailer";
import { db, notifications } from "@repo/db";
import config from "../config/config";

const mailGenerator = new Mailgen({
    theme: "default",
    product: {
        name: config.PRODUCT_NAME,
        link: config.FRONTEND_URL,
    },
});

const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: Number(config.SMTP_PORT),
    secure: Number(config.SMTP_PORT) === 465,
    auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
    },
});

const TONE_COLORS: Record<string, string> = {
    friendly: "#22BC66",
    urgent: "#F59E0B",
    final_notice: "#DC2626",
};

function recoveryMailgenContent(params: {
    customerName?: string;
    body: string;
    actionUrl?: string;
    actionText?: string;
    tone?: string;
}) {
    return {
        body: {
            name: params.customerName || "there",
            intro: params.body.split("\n").map((line) => line.trim()).filter(Boolean),
            ...(params.actionUrl && params.actionText
                ? {
                    action: {
                        instructions: "",
                        button: {
                            color: TONE_COLORS[params.tone || "friendly"] || TONE_COLORS.friendly,
                            text: params.actionText,
                            link: params.actionUrl,
                        },
                    },
                }
                : {}),
            outro: "If you've already taken care of this, please disregard this email.",
        },
    };
}

interface SendEmailOptions {
    to: string;
    subject: string;
    body: string;
    customerName?: string;
    actionUrl?: string;
    actionText?: string;
    tone?: "friendly" | "urgent" | "final_notice";
    recoveryAttemptId?: string;
    recoveryActionId?: string;
}

interface NotificationResult {
    success: boolean;
    externalId?: string;
    error?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<NotificationResult> {
    const mailgenContent = recoveryMailgenContent(options);
    const html = mailGenerator.generate(mailgenContent);
    const text = mailGenerator.generatePlaintext(mailgenContent);
    const { subject } = options;


    try {
        const info = await transporter.sendMail({
            from: config.EMAIL_FROM,
            to: options.to,
            subject,
            text,
            html,
        });

        await db.insert(notifications).values({
            recoveryAttemptId: options.recoveryAttemptId,
            recoveryActionId: options.recoveryActionId,
            channel: "email",
            recipient: options.to,
            subject,
            content: options.body,
            status: "sent",
            externalId: info.messageId,
            sentAt: new Date(),
        });

        console.log(`Email sent to ${options.to} (${info.messageId})`);
        return { success: true, externalId: info.messageId };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown SMTP error";
        console.error(`Failed to send email to ${options.to}:`, message);

        await db.insert(notifications).values({
            recoveryAttemptId: options.recoveryAttemptId,
            recoveryActionId: options.recoveryActionId,
            channel: "email",
            recipient: options.to,
            subject,
            content: options.body,
            status: "failed",
        });

        return { success: false, error: message };
    }
}

export async function sendSMS(options: { to: string; body: string; actionUrl?: string; recoveryAttemptId?: string; recoveryActionId?: string }): Promise<NotificationResult> {
    const fullBody = options.actionUrl ? `${options.body}\n\n${options.actionUrl}` : options.body;
    console.log(`[SIMULATED] SMS to ${options.to}: ${fullBody.slice(0, 80)}...`);

    await db.insert(notifications).values({
        recoveryAttemptId: options.recoveryAttemptId,
        recoveryActionId: options.recoveryActionId,
        channel: "sms",
        recipient: options.to,
        content: fullBody,
        status: "queued",
    });

    return { success: true };
}

export async function sendWhatsApp(options: { to: string; body: string; actionUrl?: string; recoveryAttemptId?: string; recoveryActionId?: string }): Promise<NotificationResult> {
    const fullBody = options.actionUrl ? `${options.body}\n\n${options.actionUrl}` : options.body;
    console.log(`[SIMULATED] WhatsApp to ${options.to}: ${fullBody.slice(0, 80)}...`);

    await db.insert(notifications).values({
        recoveryAttemptId: options.recoveryAttemptId,
        recoveryActionId: options.recoveryActionId,
        channel: "whatsapp",
        recipient: options.to,
        content: fullBody,
        status: "queued",
    });

    return { success: true };
}

export async function sendNotification(
    channel: "email" | "sms" | "whatsapp",
    params: {
        to: string;
        subject?: string;
        body: string;
        customerName?: string;
        actionUrl?: string;
        actionText?: string;
        tone?: "friendly" | "urgent" | "final_notice";
        recoveryAttemptId?: string;
        recoveryActionId?: string;
    }
): Promise<NotificationResult> {
    switch (channel) {
        case "email":
            return sendEmail({
                to: params.to,
                subject: params.subject || "About your payment",
                body: params.body,
                customerName: params.customerName,
                actionUrl: params.actionUrl,
                actionText: params.actionText,
                tone: params.tone,
                recoveryAttemptId: params.recoveryAttemptId,
                recoveryActionId: params.recoveryActionId,
            });
        case "sms":
            return sendSMS(params);
        case "whatsapp":
            return sendWhatsApp(params);
    }
}