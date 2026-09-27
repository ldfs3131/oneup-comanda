export type Role = 'ADMIN' | 'CAIXA' | 'COZINHA';
export type User = { id: number; name: string; username: string; role: Role };

export type Option = { id: number; name: string; priceDeltaCents: number; available: boolean; active: boolean };
export type OptionGroup = { id: number; name: string; required: boolean; multiple: boolean; active: boolean; options: Option[] };
export type Product = {
  id: number; categoryId: number; name: string; description: string; priceCents: number; imageUrl: string | null;
  available: boolean; active: boolean; sortOrder: number; sendsToKitchen: boolean; needsReview: boolean; reviewNote: string | null;
  groups: OptionGroup[];
};
export type Category = { id: number; name: string; sortOrder: number; active: boolean; sendsToKitchen: boolean; products: Product[] };

export type AccountListItem = {
  id: number; number: number; customerName: string | null; note: string | null; contact: string | null;
  status: string; origin: string; openedAt: string; closedAt: string | null; pendingAt: string | null;
  openedByName: string | null; pendingByName: string | null;
  subtotal: number; discounts: number; paid: number; total: number; balance: number;
  inKitchen: number; ready: number; lastOrderAt: string | null;
};

export type OrderItem = {
  id: number; orderId: number; productId: number | null; productName: string; unitPriceCents: number; quantity: number;
  optionsSnapshot: { group: string; name: string; priceDeltaCents: number }[]; note: string | null; goesToKitchen: boolean;
  status: 'ACTIVE' | 'CANCELLED';
  cancellation: { reason: string; userName: string; createdAt: string; wasInPreparation: boolean } | null;
};
export type Order = {
  id: number; number: number; sequence: number; origin: string; status: string; goesToKitchen: boolean; note: string | null;
  createdAt: string; readyAt: string | null; deliveredAt: string | null; problemNote: string | null; items: OrderItem[];
};
export type AccountDetail = {
  id: number; number: number; customerName: string | null; note: string | null; contact: string | null; status: string;
  origin: string; openedAt: string; closedAt: string | null; pendingAt: string | null;
  totals: { subtotal: number; discounts: number; total: number; paid: number; balance: number };
  orders: Order[];
  payments: { id: number; amountCents: number; tenderedCents: number | null; method: string; methodCode: string; createdAt: string; userName: string; reversedAt: string | null; reversalReason: string | null }[];
  discounts: { id: number; kind: string; amountCents: number; reason: string; createdAt: string; userName: string }[];
  cancellations: { id: number; target: string; description: string; amountCents: number; reason: string; wasInPreparation: boolean; createdAt: string; userName: string }[];
};

export type ReadyItem = {
  orderId: number; orderNumber: number; sequence: number; readyAt: string | null; problemNote: string | null; status: string;
  accountId: number; accountNumber: number; customerName: string | null; note: string | null;
};
export type AwaitingItem = {
  orderId: number; orderNumber: number; note: string | null; createdAt: string; accountId: number; accountNumber: number;
  customerName: string | null; accountNote: string | null; totalCents: number;
};
export type Board = { accounts: AccountListItem[]; ready: ReadyItem[]; awaiting: AwaitingItem[]; register: { id: number; openedAt: string } | null };

export type PaymentMethod = { id: number; code: string; name: string; isCash: boolean };

export type RegisterSummary = {
  registerId: number; openedAt: string; closedAt: string | null; openingCashCents: number; salesCents: number; ordersCount: number;
  accountsCount: number; receivedCents: number; byMethod: { code: string; name: string; cents: number; count: number }[];
  fromPreviousPendingCents: number; fromPreviousPendingCount: number; partialPaymentsCents: number; partialAccounts: number;
  pendingCreated: { id: number; number: number; customerName: string; contact: string; balance: number }[]; pendingCreatedCents: number;
  discountsCents: number; discountsCount: number; discountsByUser: { name: string; cents: number; count: number }[];
  cancellationsCents: number; cancellationsCount: number; lossCents: number; openAccountsNow: number;
  movements: { type: string; amountCents: number; reason: string; createdAt: string; userName: string }[];
  suprimentosCents: number; sangriasCents: number; cashReceivedCents: number; expectedCashCents: number;
  countedCashCents?: number; differenceCents?: number;
};

export type Settings = {
  restaurant: { name: string; isOpen: boolean; qrEnabled: boolean; whatsappNumber: string | null };
  delivery: { isOpen: boolean };
  backupDirs: string[];
  demoMode: boolean;
  lanUrls: string[];
};
