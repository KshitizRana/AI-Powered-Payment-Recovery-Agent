import { pgTable, uuid, varchar, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { customers } from "./customer";
import { subscriptionStatusEnum } from "./enums";

export const subscriptions = pgTable("subscriptions", {
    id: uuid("id").defaultRandom().primaryKey(),
    razorpaySubscriptionId: varchar("razorpay_subscription_id", { length: 255 }).unique().notNull(),
    razorpayPlanId: varchar("razorpay_plan_id", { length: 255 }),

    customerId: uuid("customer_id").references(() => customers.id),

    status: subscriptionStatusEnum("status").notNull(),
    amount: integer("amount"), // in paise
    currency: varchar("currency", { length: 10 }).default("INR"),

    currentStart: timestamp("current_start"),
    currentEnd: timestamp("current_end"),
    chargeAt: timestamp("charge_at"),
    totalCount: integer("total_count"),
    paidCount: integer("paid_count"),
    remainingCount: integer("remaining_count"),

    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
