import { pgTable, uuid, varchar, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { customers } from "./customer";
import { paymentStatusEnum, paymentMethodEnum } from "./enums";

export const payments = pgTable("payments", {
    id: uuid("id").defaultRandom().primaryKey(),
    razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }).unique(),
    razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),

    customerId: uuid("customer_id").references(() => customers.id),

    amount: integer("amount").notNull(), // in paise
    currency: varchar("currency", { length: 10 }).default("INR").notNull(),
    status: paymentStatusEnum("status").notNull(),
    method: paymentMethodEnum("method"),

    // Error details (populated on failure)
    errorCode: varchar("error_code", { length: 255 }),
    errorDescription: text("error_description"),
    errorReason: varchar("error_reason", { length: 255 }),
    errorSource: varchar("error_source", { length: 255 }),

    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
