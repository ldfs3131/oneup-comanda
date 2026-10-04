import { pgTable, serial, integer, text, boolean, timestamp, jsonb, pgEnum, index, date, } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
/** Empresa dona do registro: preenchida pelo banco a partir da conexão (RLS). Ninguém digita. */
const empresaRef = () => integer('empresa_id').notNull().default(sql `app_empresa()`);
// ---------- Plataforma (ONE Base) ----------
export const empresas = pgTable('empresas', {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    nome: text('nome').notNull(),
    produto: text('produto').notNull().default('restaurante'),
    status: text('status').notNull().default('ATIVA'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
// ---------- Enums ----------
export const roleCode = pgEnum('role_code', ['ADMIN', 'CAIXA', 'COZINHA']);
export const accountStatus = pgEnum('account_status', [
    'OPEN', 'PARTIALLY_PAID', 'PENDING', 'PAID', 'CLOSED', 'CANCELLED', 'MERGED',
]);
export const consumptionType = pgEnum('consumption_type', ['LOCAL', 'VIAGEM']);
export const stockMovementType = pgEnum('stock_movement_type', ['ENTRADA', 'VENDA', 'CANCELAMENTO', 'AJUSTE', 'DIVERGENCIA']);
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
const ts = (name) => timestamp(name, { withTimezone: true });
// ---------- Usuários ----------
export const roles = pgTable('roles', {
    id: serial('id').primaryKey(),
    code: roleCode('code').notNull().unique(),
    name: text('name').notNull(),
});
export const users = pgTable('users', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    roleId: integer('role_id').notNull().references(() => roles.id),
    active: boolean('active').notNull().default(true),
    /** usuário da ONE UP (Administrador da plataforma) dentro da empresa: o Dono não vê nem altera */
    oneup: boolean('oneup').notNull().default(false),
    pinHash: text('pin_hash'),
    pinFalhas: integer('pin_falhas').notNull().default(0),
    pinBloqueadoAte: ts('pin_bloqueado_ate'),
    createdAt: createdAt(),
});
/** Aparelho da equipe: o PIN só vale onde alguém já entrou com usuário e senha. */
export const aparelhos = pgTable('aparelhos', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    tokenHash: text('token_hash').notNull().unique(),
    nome: text('nome'),
    criadoPor: integer('criado_por').references(() => users.id),
    createdAt: createdAt(),
    ultimoUso: ts('ultimo_uso'),
    revogadoEm: ts('revogado_em'),
});
export const sessions = pgTable('sessions', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id').notNull().references(() => users.id),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    aparelhoId: integer('aparelho_id'),
});
// ---------- Cardápio ----------
export const categories = pgTable('categories', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    sendsToKitchen: boolean('sends_to_kitchen').notNull().default(true), // padrão para novos produtos
    createdAt: createdAt(),
});
export const products = pgTable('products', {
    empresaId: empresaRef(),
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
    trackStock: boolean('track_stock').notNull().default(false),
    stockQty: integer('stock_qty').notNull().default(0),
    lowStockAt: integer('low_stock_at').notNull().default(3),
    prepMinutes: integer('prep_minutes').notNull().default(15),
    costCents: integer('cost_cents'), // custo estimado atual (histórico em product_costs)
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
});
export const optionGroups = pgTable('option_groups', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id),
    name: text('name').notNull(),
    required: boolean('required').notNull().default(false),
    multiple: boolean('multiple').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
});
export const options = pgTable('options', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    groupId: integer('group_id').notNull().references(() => optionGroups.id),
    name: text('name').notNull(),
    priceDeltaCents: integer('price_delta_cents').notNull().default(0),
    stockProductId: integer('stock_product_id'), // opção que consome 1 unidade de um produto com estoque
    available: boolean('available').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
});
// ---------- Caixa ----------
export const cashRegisters = pgTable('cash_registers', {
    empresaId: empresaRef(),
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
    primeiraContagemCents: integer('primeira_contagem_cents'),
});
export const cashMovements = pgTable('cash_movements', {
    empresaId: empresaRef(),
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
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    number: integer('number').notNull().unique(),
    customerName: text('customer_name'),
    note: text('note'),
    contact: text('contact'), // casa / apto / mesa / local
    phone: text('phone'),
    tableLabel: text('table_label'),
    customerId: integer('customer_id').references(() => customers.id),
    mergedInto: integer('merged_into'),
    status: accountStatus('status').notNull().default('OPEN'),
    origin: orderOrigin('origin').notNull().default('CAIXA'),
    cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
    openedBy: integer('opened_by').references(() => users.id),
    openedAt: ts('opened_at').notNull().defaultNow(),
    pendingAt: ts('pending_at'),
    pendingBy: integer('pending_by').references(() => users.id),
    closedAt: ts('closed_at'),
    closedBy: integer('closed_by').references(() => users.id),
    promisedDate: date('promised_date', { mode: 'string' }),
    ultimaCobrancaEm: ts('ultima_cobranca_em'),
    ultimaCobrancaPor: integer('ultima_cobranca_por').references(() => users.id),
}, (t) => [index('accounts_status_idx').on(t.status)]);
export const orders = pgTable('orders', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    number: integer('number').notNull().unique(),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    sequence: integer('sequence').notNull(), // 1 = pedido inicial; 2+ = complemento
    origin: orderOrigin('origin').notNull().default('CAIXA'),
    status: orderStatus('status').notNull().default('NEW'),
    goesToKitchen: boolean('goes_to_kitchen').notNull().default(true),
    consumptionType: consumptionType('consumption_type').notNull().default('LOCAL'),
    expectedMinutes: integer('expected_minutes'),
    expectedReadyAt: ts('expected_ready_at'),
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
    publicToken: text('public_token'),
}, (t) => [index('orders_status_idx').on(t.status), index('orders_account_idx').on(t.accountId)]);
export const orderItems = pgTable('order_items', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    orderId: integer('order_id').notNull().references(() => orders.id),
    productId: integer('product_id').references(() => products.id),
    productName: text('product_name').notNull(), // congelado
    unitPriceCents: integer('unit_price_cents').notNull(), // congelado, já com opções
    quantity: integer('quantity').notNull(),
    optionsSnapshot: jsonb('options_snapshot').$type().notNull().default([]),
    note: text('note'),
    goesToKitchen: boolean('goes_to_kitchen').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    unitCostCents: integer('unit_cost_cents'), // custo congelado no momento da venda
    status: itemStatus('status').notNull().default('ACTIVE'),
}, (t) => [index('order_items_order_idx').on(t.orderId)]);
// ---------- Financeiro ----------
export const paymentMethods = pgTable('payment_methods', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    isCash: boolean('is_cash').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    /** taxa da maquininha em centésimos de ponto percentual (428 = 4,28%) */
    taxaBp: integer('taxa_bp').notNull().default(0),
});
export const payments = pgTable('payments', {
    empresaId: empresaRef(),
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
    /** taxa da forma de pagamento congelada no recebimento (null = antes do recurso) */
    taxaBp: integer('taxa_bp'),
}, (t) => [index('payments_account_idx').on(t.accountId), index('payments_register_idx').on(t.cashRegisterId)]);
export const discounts = pgTable('discounts', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    kind: discountKind('kind').notNull(),
    amountCents: integer('amount_cents').notNull(),
    totalBeforeCents: integer('total_before_cents'),
    totalAfterCents: integer('total_after_cents'),
    reason: text('reason').notNull(),
    cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
    userId: integer('user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
});
export const cancellations = pgTable('cancellations', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    target: cancellationTarget('target').notNull(),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    orderId: integer('order_id').references(() => orders.id),
    orderItemId: integer('order_item_id').references(() => orderItems.id),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull().default(0),
    quantity: integer('quantity'),
    statusBefore: text('status_before'),
    statusAfter: text('status_after'),
    stockReturned: boolean('stock_returned').notNull().default(false),
    wasInPreparation: boolean('was_in_preparation').notNull().default(false),
    reason: text('reason').notNull(),
    motivoCliente: text('motivo_cliente'),
    cashRegisterId: integer('cash_register_id').references(() => cashRegisters.id),
    userId: integer('user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
});
/** "Permitir suporte": janela em que a ONE UP vê dados de clientes (o Dono liga e ela expira sozinha). */
export const suporteLiberacoes = pgTable('suporte_liberacoes', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    ate: ts('ate').notNull(),
    criadoPor: integer('criado_por'),
    encerradoEm: ts('encerrado_em'),
    encerradoPor: integer('encerrado_por'),
    createdAt: createdAt(),
});
// ---------- Auditoria e configurações ----------
export const auditLogs = pgTable('audit_logs', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    createdAt: createdAt(),
    userId: integer('user_id').references(() => users.id),
    userRole: text('user_role'),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: integer('entity_id'),
    message: text('message').notNull(),
    data: jsonb('data'),
}, (t) => [index('audit_created_idx').on(t.createdAt)]);
export const restaurantSettings = pgTable('restaurant_settings', {
    empresaId: empresaRef(),
    id: integer('id').primaryKey().default(1),
    name: text('name').notNull().default('Happy Alpha'),
    isOpen: boolean('is_open').notNull().default(false),
    qrEnabled: boolean('qr_enabled').notNull().default(false),
    whatsappNumber: text('whatsapp_number'),
    tagline: text('tagline').notNull().default('Gourmet R2'),
    meiEnabled: boolean('mei_enabled').notNull().default(false),
    meiLimitCents: integer('mei_limit_cents').notNull().default(8_100_000),
    menuSeedVersion: integer('menu_seed_version').notNull().default(1),
    lastBackupAt: ts('last_backup_at'),
    lastBackupOk: boolean('last_backup_ok'),
    lastBackupInfo: text('last_backup_info'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
});
export const deliverySettings = pgTable('delivery_settings', {
    empresaId: empresaRef(),
    id: integer('id').primaryKey().default(1),
    isOpen: boolean('is_open').notNull().default(false),
    note: text('note'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
});
// Contadores de numeração (conta/pedido) — sequenciais e legíveis
export const counters = pgTable('counters', {
    empresaId: empresaRef(),
    name: text('name').primaryKey(),
    value: integer('value').notNull().default(0),
});
// ================= R2 =================
export const customers = pgTable('customers', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    contact: text('contact'),
    phone: text('phone'),
    note: text('note'),
    aceitaOfertas: boolean('aceita_ofertas').notNull().default(false),
    aceitaOfertasEm: ts('aceita_ofertas_em'),
    aceitaOfertasTexto: text('aceita_ofertas_texto'),
    ofertasRevogadasEm: ts('ofertas_revogadas_em'),
    anonimizadoEm: ts('anonimizado_em'),
    juntadoEm: integer('juntado_em'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [index('customers_name_idx').on(t.name)]);
/** Vendas de fora do sistema (ex.: relatório da maquininha antes da implantação). Só a ONE UP grava. */
export const referenciasExternas = pgTable('referencias_externas', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    titulo: text('titulo').notNull(),
    origem: text('origem').notNull(),
    inicio: date('inicio').notNull(),
    fim: date('fim').notNull(),
    totalCents: integer('total_cents').notNull(),
    vendas: integer('vendas').notNull(),
    taxasCents: integer('taxas_cents').notNull().default(0),
    porForma: jsonb('por_forma').$type().notNull().default([]),
    observacao: text('observacao'),
    createdAt: createdAt(),
});
export const productCosts = pgTable('product_costs', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id),
    costCents: integer('cost_cents').notNull(),
    userId: integer('user_id').references(() => users.id),
    createdAt: createdAt(),
});
export const stockMovements = pgTable('stock_movements', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    productId: integer('product_id').notNull().references(() => products.id),
    type: stockMovementType('type').notNull(),
    quantity: integer('quantity').notNull(), // + entrada / − saída
    before: integer('before').notNull(),
    after: integer('after').notNull(),
    missing: integer('missing').notNull().default(0), // divergência: unidades vendidas sem estoque registrado
    reason: text('reason'),
    orderItemId: integer('order_item_id').references(() => orderItems.id),
    userId: integer('user_id').references(() => users.id),
    unitCostCents: integer('unit_cost_cents'),
    fornecedor: text('fornecedor'),
    createdAt: createdAt(),
}, (t) => [index('stock_mov_product_idx').on(t.productId)]);
export const expenseCategories = pgTable('expense_categories', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
});
export const expenses = pgTable('expenses', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    description: text('description').notNull(),
    categoryId: integer('category_id').notNull().references(() => expenseCategories.id),
    amountCents: integer('amount_cents').notNull(),
    date: date('date').notNull(),
    note: text('note'),
    paidFromRegister: boolean('paid_from_register').notNull().default(false),
    cashMovementId: integer('cash_movement_id').references(() => cashMovements.id),
    userId: integer('user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: integer('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
});
/** Linha do tempo aberto/fechado do estabelecimento (base dos insights). */
export const statusEvents = pgTable('status_events', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    isOpen: boolean('is_open').notNull(),
    userId: integer('user_id').references(() => users.id),
    createdAt: createdAt(),
});
/** Dias fora das comparações (implantação, evento, dia atípico). */
export const excludedDays = pgTable('excluded_days', {
    empresaId: empresaRef(),
    day: date('day').primaryKey(),
    reason: text('reason').notNull(),
    userId: integer('user_id').references(() => users.id),
    createdAt: createdAt(),
});
export const orderTimeCorrections = pgTable('order_time_corrections', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    orderId: integer('order_id').notNull().references(() => orders.id),
    field: text('field').notNull(),
    before: ts('before'),
    after: ts('after'),
    reason: text('reason').notNull(),
    userId: integer('user_id').notNull().references(() => users.id),
    createdAt: createdAt(),
});
/** Respostas guardadas para evitar duplicidade (duplo clique / reenvio). */
export const idempotencyKeys = pgTable('idempotency_keys', {
    empresaId: empresaRef(),
    key: text('key').primaryKey(),
    userId: integer('user_id'),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    response: jsonb('response'),
    createdAt: createdAt(),
});
/** Insights exibidos (evita repetir o mesmo insight sem mudança relevante). */
export const insightLog = pgTable('insight_log', {
    empresaId: empresaRef(),
    id: serial('id').primaryKey(),
    key: text('key').notNull(),
    bucket: text('bucket').notNull(),
    payload: jsonb('payload'),
    createdAt: createdAt(),
}, (t) => [index('insight_log_key_idx').on(t.key)]);
// ---------- Personalização (catálogo de configurações) ----------
export const empresaConfig = pgTable('empresa_config', {
    empresaId: empresaRef(),
    chave: text('chave').notNull(),
    valor: jsonb('valor'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: integer('updated_by').references(() => users.id),
});
export const configHistorico = pgTable('config_historico', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    chave: text('chave').notNull(),
    antes: jsonb('antes'),
    depois: jsonb('depois'),
    origem: text('origem').notNull(),
    userId: integer('user_id').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
});
export const configTravas = pgTable('config_travas', {
    empresaId: empresaRef(),
    chave: text('chave').notNull(),
    motivo: text('motivo').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
});
// ---------- Central de Análise e Recuperação de vendas (só o acesso ONE UP) ----------
export const analiseRelatorios = pgTable('analise_relatorios', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    mes: text('mes').notNull(),
    status: text('status').notNull().default('RASCUNHO'),
    parecer: text('parecer').notNull().default(''),
    acoes: jsonb('acoes').$type().notNull().default([]),
    retrato: jsonb('retrato'),
    finalizadoEm: ts('finalizado_em'),
    userId: integer('user_id').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    createdAt: createdAt(),
});
export const crmCobrancas = pgTable('crm_cobrancas', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    accountId: integer('account_id').notNull().references(() => accounts.id),
    status: text('status').notNull().default('NOVO'),
    entradaEm: ts('entrada_em').notNull().defaultNow(),
    pendenteDesde: ts('pendente_desde').notNull(),
    valorEntradaCents: integer('valor_entrada_cents').notNull(),
    diasAtrasoEntrada: integer('dias_atraso_entrada').notNull().default(0),
    percentualBp: integer('percentual_bp').notNull().default(0),
    proximoContato: date('proximo_contato'),
    prometidoPara: date('prometido_para'),
    tentativas: integer('tentativas').notNull().default(0),
    promessasQuebradas: integer('promessas_quebradas').notNull().default(0),
    recuperadoCents: integer('recuperado_cents').notNull().default(0),
    comissaoCents: integer('comissao_cents').notNull().default(0),
    recuperadoEm: ts('recuperado_em'),
    encerradoEm: ts('encerrado_em'),
    naoCobrarMotivo: text('nao_cobrar_motivo'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
});
export const crmEventos = pgTable('crm_eventos', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    cobrancaId: integer('cobranca_id').notNull().references(() => crmCobrancas.id),
    tipo: text('tipo').notNull(),
    canal: text('canal'),
    resultado: text('resultado'),
    dataPrometida: date('data_prometida'),
    nota: text('nota'),
    userId: integer('user_id').references(() => users.id),
    createdAt: createdAt(),
});
export const crmConfig = pgTable('crm_config', {
    empresaId: integer('empresa_id').primaryKey().default(sql `app_empresa()`),
    config: jsonb('config').$type().notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
});
/** Pendência resolvida (avulso repetido ignorado, divergência conferida): some da lista. */
export const pendenciasResolvidas = pgTable('pendencias_resolvidas', {
    id: serial('id').primaryKey(),
    empresaId: empresaRef(),
    tipo: text('tipo').notNull(),
    chave: text('chave').notNull(),
    acao: text('acao').notNull(),
    userId: integer('user_id').references(() => users.id),
    createdAt: createdAt(),
});
