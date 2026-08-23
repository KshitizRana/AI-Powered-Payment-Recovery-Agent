CREATE TYPE "action_status" AS ENUM('pending', 'sent', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "action_type" AS ENUM('retry_payment', 'send_payment_link', 'send_email', 'send_sms', 'send_whatsapp', 'escalate', 'no_action');--> statement-breakpoint
CREATE TYPE "audit_actor" AS ENUM('system', 'ai', 'webhook', 'user');--> statement-breakpoint
CREATE TYPE "failure_category" AS ENUM('soft_decline', 'hard_decline', 'gateway_error', 'checkout_abandoned', 'unknown');--> statement-breakpoint
CREATE TYPE "notification_channel" AS ENUM('email', 'sms', 'whatsapp');--> statement-breakpoint
CREATE TYPE "notification_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'bounced');--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM('card', 'upi', 'netbanking', 'wallet', 'emi', 'bank_transfer');--> statement-breakpoint
CREATE TYPE "payment_status" AS ENUM('created', 'authorized', 'captured', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "recovery_status" AS ENUM('detected', 'diagnosed', 'intervention_planned', 'intervention_sent', 'waiting', 'recovered', 'escalated', 'abandoned');--> statement-breakpoint
CREATE TYPE "recovery_type" AS ENUM('subscription_renewal', 'checkout_abandonment');--> statement-breakpoint
CREATE TYPE "subscription_status" AS ENUM('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"razorpay_payment_id" varchar(255) UNIQUE,
	"razorpay_order_id" varchar(255),
	"customer_id" uuid,
	"amount" integer NOT NULL,
	"currency" varchar(10) DEFAULT 'INR' NOT NULL,
	"status" "payment_status" NOT NULL,
	"method" "payment_method",
	"error_code" varchar(255),
	"error_description" text,
	"error_reason" varchar(255),
	"error_source" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"razorpay_customer_id" varchar(255) UNIQUE,
	"email" varchar(255),
	"phone" varchar(20),
	"name" varchar(255),
	"total_recovery_attempts" integer DEFAULT 0 NOT NULL,
	"successful_recoveries" integer DEFAULT 0 NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"preferred_channel" "notification_channel",
	"last_contacted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"razorpay_subscription_id" varchar(255) NOT NULL UNIQUE,
	"razorpay_plan_id" varchar(255),
	"customer_id" uuid,
	"status" "subscription_status" NOT NULL,
	"amount" integer,
	"currency" varchar(10) DEFAULT 'INR',
	"current_start" timestamp,
	"current_end" timestamp,
	"charge_at" timestamp,
	"total_count" integer,
	"paid_count" integer,
	"remaining_count" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" "recovery_type" NOT NULL,
	"payment_id" uuid,
	"subscription_id" uuid,
	"customer_id" uuid,
	"razorpay_entity_id" varchar(255) NOT NULL,
	"status" "recovery_status" NOT NULL,
	"failure_category" "failure_category",
	"decline_code" varchar(255),
	"ai_diagnosis" text,
	"ai_recommended_action" "action_type",
	"current_step" integer DEFAULT 0 NOT NULL,
	"max_steps" integer DEFAULT 5 NOT NULL,
	"amount_at_risk" integer NOT NULL,
	"amount_recovered" integer DEFAULT 0 NOT NULL,
	"currency" varchar(10) DEFAULT 'INR' NOT NULL,
	"inngest_function_id" varchar(255),
	"metadata" jsonb,
	"recovered_at" timestamp,
	"abandoned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recovery_attempt_id" uuid,
	"event_type" varchar(100) NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"details" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recovery_attempt_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"action_type" "action_type" NOT NULL,
	"status" "action_status" NOT NULL,
	"ai_reasoning" text,
	"channel" "notification_channel",
	"message_content" text,
	"payment_link_id" varchar(255),
	"payment_link_url" varchar(1024),
	"response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"recovery_attempt_id" uuid,
	"recovery_action_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"recipient" varchar(255) NOT NULL,
	"subject" varchar(500),
	"content" text NOT NULL,
	"status" "notification_status" NOT NULL,
	"external_id" varchar(255),
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_subscription_id_subscriptions_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id");--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_customer_id_customers_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_recovery_attempt_id_recovery_attempts_id_fkey" FOREIGN KEY ("recovery_attempt_id") REFERENCES "recovery_attempts"("id");--> statement-breakpoint
ALTER TABLE "recovery_actions" ADD CONSTRAINT "recovery_actions_recovery_attempt_id_recovery_attempts_id_fkey" FOREIGN KEY ("recovery_attempt_id") REFERENCES "recovery_attempts"("id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recovery_attempt_id_recovery_attempts_id_fkey" FOREIGN KEY ("recovery_attempt_id") REFERENCES "recovery_attempts"("id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recovery_action_id_recovery_actions_id_fkey" FOREIGN KEY ("recovery_action_id") REFERENCES "recovery_actions"("id");