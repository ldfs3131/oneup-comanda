CREATE TYPE "public"."consumption_type" AS ENUM('LOCAL', 'VIAGEM');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('ENTRADA', 'VENDA', 'CANCELAMENTO', 'AJUSTE', 'DIVERGENCIA');--> statement-breakpoint
ALTER TYPE "public"."account_status" ADD VALUE 'MERGED';--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"phone" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excluded_days" (
	"day" date PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "expense_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"category_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"date" date NOT NULL,
	"note" text,
	"paid_from_register" boolean DEFAULT false NOT NULL,
	"cash_movement_id" integer,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" integer,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" integer,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"bucket" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_time_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"field" text NOT NULL,
	"before" timestamp with time zone,
	"after" timestamp with time zone,
	"reason" text NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"cost_cents" integer NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"is_open" boolean NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"type" "stock_movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"before" integer NOT NULL,
	"after" integer NOT NULL,
	"missing" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"order_item_id" integer,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "table_label" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "customer_id" integer;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "merged_into" integer;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_role" text;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "quantity" integer;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "status_before" text;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "status_after" text;--> statement-breakpoint
ALTER TABLE "cancellations" ADD COLUMN "stock_returned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "total_before_cents" integer;--> statement-breakpoint
ALTER TABLE "discounts" ADD COLUMN "total_after_cents" integer;--> statement-breakpoint
ALTER TABLE "options" ADD COLUMN "stock_product_id" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "is_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "unit_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "consumption_type" "consumption_type" DEFAULT 'LOCAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expected_minutes" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expected_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stock_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "low_stock_at" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "prep_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "tagline" text DEFAULT 'Gourmet R2' NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "mei_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "mei_limit_cents" integer DEFAULT 8100000 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "menu_seed_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "last_backup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "last_backup_ok" boolean;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "last_backup_info" text;--> statement-breakpoint
ALTER TABLE "excluded_days" ADD CONSTRAINT "excluded_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cash_movement_id_cash_movements_id_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "public"."cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_time_corrections" ADD CONSTRAINT "order_time_corrections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_time_corrections" ADD CONSTRAINT "order_time_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_costs" ADD CONSTRAINT "product_costs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_events" ADD CONSTRAINT "status_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "insight_log_key_idx" ON "insight_log" USING btree ("key");--> statement-breakpoint
CREATE INDEX "stock_mov_product_idx" ON "stock_movements" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;