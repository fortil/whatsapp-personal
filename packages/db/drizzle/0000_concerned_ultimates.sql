CREATE TYPE "public"."birthday_source" AS ENUM('google', 'manual');--> statement-breakpoint
CREATE TYPE "public"."msg_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."msg_type" AS ENUM('text', 'audio', 'image', 'video', 'document', 'sticker', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('contacts_sync', 'summarize', 'contacts_export', 'birthday_import', 'birthday_calendar_sync');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."transcript_status" AS ENUM('none', 'pending', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending_verification', 'pending_approval', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."verification_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."verification_purpose" AS ENUM('signup_email', 'signup_phone', 'login', 'password_reset', 'email_change');--> statement-breakpoint
CREATE TYPE "public"."wa_state" AS ENUM('connecting', 'connected', 'disconnected', 'logged_out');--> statement-breakpoint
CREATE TABLE "birthday_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"google_event_id" text,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"last_verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wa_jid" text NOT NULL,
	"phone_e164" text,
	"is_lid" boolean DEFAULT false NOT NULL,
	"merged_into_contact_id" uuid,
	"display_name" text,
	"wa_name" text,
	"birth_month" integer,
	"birth_day" integer,
	"birth_year" integer,
	"birthday_source" "birthday_source",
	"google_resource_name" text
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"contact_id" uuid,
	"wa_jid" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"summary" text,
	"summary_model" text,
	"summary_updated_at" timestamp with time zone,
	"summary_thru_created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scopes" text NOT NULL,
	"people_sync_token" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "google_accounts_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"external_id" text,
	"direction" "msg_direction" NOT NULL,
	"type" "msg_type" DEFAULT 'text' NOT NULL,
	"body" text,
	"media_mime" text,
	"read_at" timestamp with time zone,
	"transcript" text,
	"transcript_status" "transcript_status" DEFAULT 'none' NOT NULL,
	"transcript_model" text,
	"transcribed_at" timestamp with time zone,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "task_kind" NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"file_path" text,
	"error" text,
	"params" jsonb,
	"bullmq_job_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trusted_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'pending_verification' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"rejected_reason" text,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "verification_channel" NOT NULL,
	"purpose" "verification_purpose" NOT NULL,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"instance_name" text NOT NULL,
	"state" "wa_state" DEFAULT 'connecting' NOT NULL,
	"connected_jid" text,
	"last_state_at" timestamp with time zone,
	CONSTRAINT "wa_instances_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "wa_instances_instance_name_unique" UNIQUE("instance_name")
);
--> statement-breakpoint
ALTER TABLE "birthday_events" ADD CONSTRAINT "birthday_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "birthday_events" ADD CONSTRAINT "birthday_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_contact_id_contacts_id_fk" FOREIGN KEY ("merged_into_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_instances" ADD CONSTRAINT "wa_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "birthday_events_user_contact_uq" ON "birthday_events" USING btree ("user_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_user_jid_uq" ON "contacts" USING btree ("user_id","wa_jid");--> statement-breakpoint
CREATE INDEX "contacts_user_phone_idx" ON "contacts" USING btree ("user_id","phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_user_jid_uq" ON "conversations" USING btree ("user_id","wa_jid");--> statement-breakpoint
CREATE INDEX "conversations_user_last_message_idx" ON "conversations" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_external_uq" ON "messages" USING btree ("conversation_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_keyset_idx" ON "messages" USING btree ("conversation_id","sent_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" USING btree ("conversation_id") WHERE direction = 'in' AND read_at IS NULL;--> statement-breakpoint
CREATE INDEX "task_runs_user_idx" ON "task_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_runs_status_updated_idx" ON "task_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "trusted_devices_user_idx" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_codes_user_channel_purpose_idx" ON "verification_codes" USING btree ("user_id","channel","purpose");