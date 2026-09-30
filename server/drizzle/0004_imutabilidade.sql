-- R2.0.2 — Nada é EDITADO nem ESVAZIADO depois de gravado.
-- Complementa 0001/0003 (que já impedem apagar linha a linha).
-- Só acrescenta travas: não altera nenhum dado existente.

-- 1) Tabelas que o sistema nunca atualiza: qualquer UPDATE é recusado.
CREATE OR REPLACE FUNCTION ha_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registros de % não podem ser alterados.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER no_update_audit_logs BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_update_status_events BEFORE UPDATE ON status_events FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_update_product_costs BEFORE UPDATE ON product_costs FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_update_time_corrections BEFORE UPDATE ON order_time_corrections FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_update_cash_movements BEFORE UPDATE ON cash_movements FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_update_stock_movements BEFORE UPDATE ON stock_movements FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint

-- 2) Pagamentos: valor, forma, troco, caixa, operador e horário congelados.
--    Permitido só: mover para outra conta (juntar contas) e estornar UMA vez.
CREATE OR REPLACE FUNCTION ha_freeze_payment() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.method_id IS DISTINCT FROM OLD.method_id
     OR NEW.tendered_cents IS DISTINCT FROM OLD.tendered_cents
     OR NEW.cash_register_id IS DISTINCT FROM OLD.cash_register_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Pagamentos não podem ser alterados. Use o estorno.';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND (
       NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
       OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by
       OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason) THEN
    RAISE EXCEPTION 'Estorno já registrado não pode ser alterado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER freeze_payments BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION ha_freeze_payment();
--> statement-breakpoint

-- 3) Descontos e cancelamentos: tudo congelado, exceto mover para outra conta (juntar contas).
CREATE OR REPLACE FUNCTION ha_freeze_except_account() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'account_id') IS DISTINCT FROM (to_jsonb(OLD) - 'account_id') THEN
    RAISE EXCEPTION 'Registros de % não podem ser alterados.', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER freeze_discounts BEFORE UPDATE ON discounts FOR EACH ROW EXECUTE FUNCTION ha_freeze_except_account();
--> statement-breakpoint
CREATE TRIGGER freeze_cancellations BEFORE UPDATE ON cancellations FOR EACH ROW EXECUTE FUNCTION ha_freeze_except_account();
--> statement-breakpoint

-- 4) Despesas: tudo congelado; permitido só cancelar UMA vez (com motivo).
CREATE OR REPLACE FUNCTION ha_freeze_expense() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by' - 'cancel_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by' - 'cancel_reason')
     OR (OLD.cancelled_at IS NOT NULL AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason)) THEN
    RAISE EXCEPTION 'Despesas não podem ser alteradas. Cancele e lance de novo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER freeze_expenses BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION ha_freeze_expense();
--> statement-breakpoint

-- 5) Caixa fechado não muda mais (esperado, contado, diferença, horários).
CREATE OR REPLACE FUNCTION ha_freeze_closed_register() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CLOSED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Caixa já fechado não pode ser alterado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER freeze_closed_registers BEFORE UPDATE ON cash_registers FOR EACH ROW EXECUTE FUNCTION ha_freeze_closed_register();
--> statement-breakpoint

-- 6) Ninguém esvazia tabela de movimento com TRUNCATE.
CREATE OR REPLACE FUNCTION ha_block_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A tabela % não pode ser esvaziada.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER no_truncate_accounts BEFORE TRUNCATE ON accounts FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_orders BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_order_items BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_payments BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_discounts BEFORE TRUNCATE ON discounts FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_cancellations BEFORE TRUNCATE ON cancellations FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_cash_registers BEFORE TRUNCATE ON cash_registers FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_audit_logs BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_stock_movements BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_expenses BEFORE TRUNCATE ON expenses FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_product_costs BEFORE TRUNCATE ON product_costs FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_status_events BEFORE TRUNCATE ON status_events FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_time_corrections BEFORE TRUNCATE ON order_time_corrections FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint
CREATE TRIGGER no_truncate_cash_movements BEFORE TRUNCATE ON cash_movements FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
