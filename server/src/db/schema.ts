import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, pgEnum, index,
} from 'drizzle-orm/pg-core';

// ---------- Enums ----------
export const roleCode = pgEnum('role_code', ['ADMIN', 'CAIXA', 'COZINHA']);
export const accountStatus = pgEnum('account_status', [
  'OPEN', 'PARTIALLY_PAID', 'PENDING', 'PAID', 'CLOSED', 'CANCELLED',
]);
export const orderStatus = pgEnum('order_status', [
  'NEW', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'CANCELLED',
]);
export const orderOrigin = pgEnum('order_origin', ['CAIXA', 'QR_CODE', 'WHATSAPP', 'DELIVERY']);
export const itemStatus = pgEnum('item_status', ['ACTIVE', 'CANCELLED']);
export const cancellationTarget = pgEnum('cancellation_target', ['ITEM', 'ORDER', 'ACCOUNT']);
export const discountKind = pgEnum('discount_kind', ['DISCOUNT', 'ADJUSTMENT']);
export const registerStatus = pgEnum('register_status', ['OPEN', 'CLOSED']);
export const movementType = pgEnum('movement_type', ['SANGRIA', 'SUPRIMENTO']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------- Usuários ----------
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  code: roleCode('code').notNull().unique(),
  name: text('name').notNull(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  roleId: integer('role_id').notNull().references(() => roles.id),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

// ---------- Cardápio ----------
export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  sendsToKitchen: boolean('sends_to_kitchen').notNull().default(true), // padrão para novos produtos
  createdAt: createdAt(),
});

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull().references(() => categories.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceCents: integer('price_cents').notNull(),
  imageUrl: text('image_url'),
  available: boolean('available').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  sendsToKitchen: boolean('sends_to_kitchen').notNull().default(true),
  needsReview: boolean('needs_review').notNull().default(false),
  reviewNote: text('review_note'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const optionGroups = pgTable('option_groups', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id),
  name: text('name').notNull(),
  required: boolean('required').notNull().default(false),
  multiple: boolean('multiple').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const options = pgTable('options', {
  id: serial('id').primaryKey(),
  groupId: integer('group_id').notNull().references(() => optionGroups.id),
  name: text('name').notNull(),
  priceDeltaCents: integer('price_delta_cents').notNull().default(0),
  available: boolean('available').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

// ---------- Caixa ----------
export const cashRegisters = pgTable('cash_registers', {
  id: serial('id').primaryKey(),
  status: registerStatus('status').notNull().default('OPEN'),
  openedBy: integer('opened_by').notNull().references(() => users.id),
  openedAt: ts('opened_at').notNull().defaultNow(),
  openingCashCents: integer('opening_cash_cents').notNull(),
  closedBy: integer('closed_by').references(() => users.id),
  closedAt: ts('closed_at'),
  expectedCashCents: integer('expected_cash_cents'),
  countedCashCents: integer('counted_cash_cents'),
  differenceCents: integer('difference_cents'),
  closingNote: text('closing_note'),
  summary: jsonb('summary'),
});

export const cashMovements = pgTable('cash_movements', {
  id: serial('id').primaryKey(),
  cashRegisterId: integer('cash_register_id').notNull().references(() => cashRegisters.id),
  type: movementType('type').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: createdAt(),
});

// ---------- Contas e pedidos ----------
export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  number: integer('number').notNull().unique(),
  customerName: text('customer_name'),
  note: text('note'),
  contact: text('contact'),
  status: accountStatus('status').notNull().default('OPEN'),
  origin: orderOrigin('origin').notNull().default('CAIXA'),
  cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
  openedBy: integer('opened_by').references(() => users.id),
  openedAt: ts('opened_at').notNull().defaultNow(),
  pendingAt: ts('pending_at'),
  pendingBy: integer('pending_by').references(() => users.id),
  closedAt: ts('closed_at'),
  closedBy: integer('closed_by').references(() => users.id),
}, (t) => [index('accounts_status_idx').on(t.status)]);

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  number: integer('number').notNull().unique(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  sequence: integer('sequence').notNull(), // 1 = pedido inicial; 2+ = complemento
  origin: orderOrigin('origin').notNull().default('CAIXA'),
  status: orderStatus('status').notNull().default('NEW'),
  goesToKitchen: boolean('goes_to_kitchen').notNull().default(true),
  note: text('note'),
  cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
  createdBy: integer('created_by').references(() => users.id),
  createdAt: createdAt(),
  confirmedAt: ts('confirmed_at'),
  confirmedBy: integer('confirmed_by').references(() => users.id),
  startedAt: ts('started_at'),
  startedBy: integer('started_by').references(() => users.id),
  readyAt: ts('ready_at'),
  readyBy: integer('ready_by').references(() => users.id),
  deliveredAt: ts('delivered_at'),
  deliveredBy: integer('delivered_by').references(() => users.id),
  problemNote: text('problem_note'),
  problemAt: ts('problem_at'),
}, (t) => [index('orders_status_idx').on(t.status), index('orders_account_idx').on(t.accountId)]);

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  productId: integer('product_id').references(() => products.id),
  productName: text('product_name').notNull(),       // congelado
  unitPriceCents: integer('unit_price_cents').notNull(), // congelado, já com opções
  quantity: integer('quantity').notNull(),
  optionsSnapshot: jsonb('options_snapshot').$type<{ group: string; name: string; priceDeltaCents: number }[]>().notNull().default([]),
  note: text('note'),
  goesToKitchen: boolean('goes_to_kitchen').notNull(),
  status: itemStatus('status').notNull().default('ACTIVE'),
}, (t) => [index('order_items_order_idx').on(t.orderId)]);

// ---------- Financeiro ----------
export const paymentMethods = pgTable('payment_methods', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  isCash: boolean('is_cash').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  methodId: integer('method_id').notNull().references(() => paymentMethods.id),
  amountCents: integer('amount_cents').notNull(),
  tenderedCents: integer('tendered_cents'), // dinheiro entregue (para troco)
  cashRegisterId: integer('cash_register_id').notNull().references(() => cashRegisters.id),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: createdAt(),
  reversedAt: ts('reversed_at'),
  reversedBy: integer('reversed_by').references(() => users.id),
  reversalReason: text('reversal_reason'),
}, (t) => [index('payments_account_idx').on(t.accountId), index('payments_register_idx').on(t.cashRegisterId)]);

export const discounts = pgTable('discounts', {
  id: serial('id').primaryKey(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  kind: discountKind('kind').notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason').notNull(),
  cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: createdAt(),
});

export const cancellations = pgTable('cancellations', {
  id: serial('id').primaryKey(),
  target: cancellationTarget('target').notNull(),
  accountId: integer('account_id').notNull().references(() => accounts.id),
  orderId: integer('order_id').references(() => orders.id),
  orderItemId: integer('order_item_id').references(() => orderItems.id),
  description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull().default(0),
  wasInPreparation: boolean('was_in_preparation').notNull().default(false),
  reason: text('reason').notNull(),
  cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: createdAt(),
});

// ---------- Auditoria e configurações ----------
export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  createdAt: createdAt(),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  message: text('message').notNull(),
  data: jsonb('data'),
}, (t) => [index('audit_created_idx').on(t.createdAt)]);

export const restaurantSettings = pgTable('restaurant_settings', {
  id: integer('id').primaryKey().default(1),
  name: text('name').notNull().default('Happy Alpha'),
  isOpen: boolean('is_open').notNull().default(false),
  qrEnabled: boolean('qr_enabled').notNull().default(false),
  whatsappNumber: text('whatsapp_number'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const deliverySettings = pgTable('delivery_settings', {
  id: integer('id').primaryKey().default(1),
  isOpen: boolean('is_open').notNull().default(false),
  note: text('note'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// Contadores de numeração (conta/pedido) — sequenciais e legíveis
export const counters = pgTable('counters', {
  name: text('name').primaryKey(),
  value: integer('value').notNull().default(0),
});
