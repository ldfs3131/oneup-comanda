-- ONE UP Comanda 3.2.1 — correções da auditoria do comitê (04/10). Tudo aditivo e reaplicável.

-- Sessão ligada ao aparelho: tirar o acesso do aparelho derruba quem já está logado nele
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS aparelho_id integer REFERENCES aparelhos(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_aparelho_idx ON sessions (aparelho_id) WHERE aparelho_id IS NOT NULL;
--> statement-breakpoint
-- Telas "ao vivo": com RLS o filtro por status não usa índice comum; índices parciais por empresa resolvem
CREATE INDEX IF NOT EXISTS accounts_vivas_idx ON accounts (empresa_id, id) WHERE status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS accounts_pendentes_idx ON accounts (empresa_id, id) WHERE status = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS orders_vivos_idx ON orders (empresa_id, id) WHERE status IN ('AWAITING_CONFIRMATION', 'CONFIRMED', 'IN_PREPARATION', 'READY');
--> statement-breakpoint
-- Resumo e fechamento do caixa
CREATE INDEX IF NOT EXISTS orders_caixa_idx ON orders (empresa_id, cash_register_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discounts_caixa_idx ON discounts (empresa_id, cash_register_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cancellations_caixa_idx ON cancellations (empresa_id, cash_register_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cash_movements_caixa_idx ON cash_movements (empresa_id, cash_register_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discounts_conta_idx ON discounts (empresa_id, account_id);
--> statement-breakpoint
-- Estoque (cancelamento) e sugestão de compra / pendências
CREATE INDEX IF NOT EXISTS stock_mov_item_idx ON stock_movements (empresa_id, order_item_id) WHERE order_item_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_items_produto_idx ON order_items (empresa_id, product_id);
--> statement-breakpoint
-- Auditoria: detalhe do pedido/conta
CREATE INDEX IF NOT EXISTS audit_entidade_idx ON audit_logs (empresa_id, entity_type, entity_id);
