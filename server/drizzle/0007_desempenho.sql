-- Comitê de testes (01/10): consultas por período usam índice (empresa + data).
-- O painel do dono e o financeiro filtram por intervalo de horário, não mais por "data convertida" (que ignorava índice).
CREATE INDEX IF NOT EXISTS orders_empresa_created_idx ON orders (empresa_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payments_empresa_created_idx ON payments (empresa_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discounts_empresa_created_idx ON discounts (empresa_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cancellations_empresa_created_idx ON cancellations (empresa_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expenses_empresa_date_idx ON expenses (empresa_id, date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS accounts_empresa_status_idx ON accounts (empresa_id, status);
