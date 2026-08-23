import { pgTable, uuid, varchar, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { customers } from "./customer";
import { payments } from "./payments";

import {
    recoveryTypeEnum,
    recoveryStatusEnum,
    failureCategoryEnum,
    actionTypeEnum,
} from "./enums";
import { subscriptions } from "./subscription";

export const recoveryAttempts = pgTable("recovery_attempts", {
    id: uuid("id").defaultRandom().primaryKey(),

    type: recoveryTypeEnum("type").notNull(),

    // Links
    paymentId: uuid("payment_id").references(() => payments.id),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
    customerId: uuid("customer_id").references(() => customers.id),
    razorpayEntityId: varchar("razorpay_entity_id", { length: 255 }).notNull(),

    // State machine
    status: recoveryStatusEnum("status").notNull(),
    failureCategory: failureCategoryEnum("failure_category"),
    declineCode: varchar("decline_code", { length: 255 }),

    // AI
    aiDiagnosis: text("ai_diagnosis"),
    aiRecommendedAction: actionTypeEnum("ai_recommended_action"),

    // Escalation
    currentStep: integer("current_step").default(0).notNull(),
    maxSteps: integer("max_steps").default(5).notNull(),

    // 💰 The money metric
    amountAtRisk: integer("amount_at_risk").notNull(), // paise
    amountRecovered: integer("amount_recovered").default(0).notNull(),
    currency: varchar("currency", { length: 10 }).default("INR").notNull(),

    inngestFunctionId: varchar("inngest_function_id", { length: 255 }),

    metadata: jsonb("metadata"),
    recoveredAt: timestamp("recovered_at"),
    abandonedAt: timestamp("abandoned_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
