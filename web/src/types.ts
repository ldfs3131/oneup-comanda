export type Role = 'ADMIN' | 'CAIXA' | 'COZINHA';
export type User = { id: number; name: string; username: string; role: Role; /** acesso da ONE UP (Administrador da plataforma) */ oneup?: boolean };

export type Option = { id: number; name: string; priceDeltaCents: number; available: boolean; active: boolean; stockProductId?: number | null };
export type OptionGroup = { id: number; name: string; required: boolean; multiple: boolean; active: boolean; options: Option[] };
export type Product = {
  id: number; categoryId: number; name: string; description: string; priceCents: number; imageUrl: string | null;
  available: boolean; active: boolean; sortOrder: number; sendsToKitchen: boolean; needsReview: boolean; reviewNote: string | null;
  trackStock: boolean; stockQty: number; lowStockAt: number | null; prepMinutes: number | null; costCents: number | null; sold30?: number;
  groups: OptionGroup[];
};
export type Category = { id: number; name: string; sortOrder: number; active: boolean; sendsToKitchen: boolean; products: Product[] };

export type Consumption = 'LOCAL' | 'VIAGEM';

export type AccountListItem = {
  id: number; number: number; customerName: string | null; note: string | null; contact: string | null;
  phone: string | null; tableLabel: string | null; customerId: number | null;
  status: string; origin: string; openedAt: string; closedAt: string | null; pendingAt: string | null;
  openedByName: string | null; pendingByName: string | null;
  subtotal: number; discounts: number; paid: number; total: number; balance: number;
  inKitchen: number; ready: number; lastOrderAt: string | null; nextReadyAt: string | null;
  promisedDate?: string | null; ultimaCobrancaEm?: string | null; ultimaCobrancaPor?: string | null;
  situacao?: 'venceu' | 'hoje' | 'sem_data' | 'em_dia';
};

export type OrderItem = {
  id: number; orderId: number; productId: number | null; productName: string; unitPriceCents: number; quantity: number;
  optionsSnapshot: { group: string; name: string; priceDeltaCents: number }[]; note: string | null; goesToKitchen: boolean;
  isCustom: boolean; unitCostCents: number | null;
  status: 'ACTIVE' | 'CANCELLED';
  cancellation: { reason: string; userName: string; createdAt: string; wasInPreparation: boolean; quantity: number | null; stockReturned: boolean } | null;
};
export type Situation = 'PAGO' | 'PARCIAL' | 'PENDENTE' | '—';
export type Order = {
  id: number; number: number; sequence: number; origin: string; status: string; goesToKitchen: boolean; note: string | null;
  consumptionType: Consumption; expectedMinutes: number | null; expectedReadyAt: string | null;
  createdAt: string; confirmedAt: string | null; startedAt: string | null; readyAt: string | null; deliveredAt: string | null; problemNote: string | null;
  totalCents: number; situation: Situation; items: OrderItem[];
};
export type AccountDetail = {
  id: number; number: number; customerName: string | null; note: string | null; contact: string | null; status: string;
  phone: string | null; tableLabel: string | null; mergedInto: number | null; mergedIntoNumber: number | null;
  origin: string; openedAt: string; closedAt: string | null; pendingAt: string | null;
  totals: { subtotal: number; discounts: number; total: number; paid: number; balance: number };
  orders: Order[];
  payments: { id: number; amountCents: number; tenderedCents: number | null; method: string; methodCode: string; createdAt: string; userName: string; reversedAt: string | null; reversalReason: string | null }[];
  discounts: { id: number; kind: string; amountCents: number; reason: string; totalBeforeCents: number | null; totalAfterCents: number | null; createdAt: string; userName: string }[];
  cancellations: { id: number; target: string; description: string; amountCents: number; reason: string; wasInPreparation: boolean; quantity: number | null; stockReturned: boolean; createdAt: string; userName: string }[];
};

export type ReadyItem = {
  orderId: number; orderNumber: number; sequence: number; readyAt: string | null; problemNote: string | null; status: string;
  consumptionType: Consumption; accountId: number; accountNumber: number; customerName: string | null; note: string | null; tableLabel: string | null;
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
  suprimentosCents: number; sangriasCents: number; cashReceivedCents: number | null; expectedCashCents: number | null;
  countedCashCents?: number; differenceCents?: number;
};

export type Settings = {
  restaurant: { name: string; tagline: string | null; isOpen: boolean; qrEnabled: boolean; whatsappNumber: string | null; meiEnabled: boolean; meiLimitCents: number };
  delivery: { isOpen: boolean };
  backupDirs: string[];
  demoMode: boolean;
  lanUrls: string[];
  publicPort: number | null;
  version: string;
  insightsEnabled: boolean;
  product?: string;
  /** valores efetivos do catálogo de personalização */
  config: Record<string, any>;
  /** licença online (Dono: com vencimento e aviso; Caixa/Cozinha: só o status) */
  licenca?: Licenca;
};

export type LicencaStatus = 'ATIVO' | 'SO_CONSULTA' | 'SUSPENSO';
export type Licenca = {
  status: LicencaStatus; definido?: LicencaStatus; venceEm?: string | null; diasParaVencer?: number | null; vencida?: boolean; avisar?: boolean; diaAberto?: boolean;
};

export type StockShortage = { productId: number; name: string; stock: number; requested: number };
export type StockDecision = { productId: number; action: 'CORRECT'; newQty: number } | { productId: number; action: 'RELEASE'; reason: string };

export type CustomerSuggestion = { id: number; name: string; contact: string | null; phone: string | null; pendingCents: number; pendingSince: string | null; pendingCount: number };

export type InsightMetric = { label: string; current: number; reference?: number; diffAbs?: number; diffPct?: number; unit: 'BRL' | 'COUNT' | 'PCT' | 'MIN'; range?: [number, number] };
export type Insight = {
  key: string; bucket: string; type: string; kind: 'DADO' | 'ESTIMATIVA' | 'INSIGHT' | 'RECOMENDACAO'; scope: 'DIA' | 'PERIODO';
  title: string; text: string; action?: string; metric: InsightMetric; period: string; comparison?: string;
  confidence: 'ALTA' | 'MEDIA'; score: number; repeated?: boolean;
  detail: { method: string; samples: string; series?: { label: string; value: number; highlight?: boolean }[]; seriesUnit?: InsightMetric['unit'] };
};
export type InsightsResult = { level: 1 | 2 | 3 | 4; dataDays: number; firstDay: string | null; message: string; top: Insight[]; all: Insight[]; generatedAt: string };
