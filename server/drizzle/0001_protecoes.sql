-- Nunca apagar registros operacionais/financeiros (regra do briefing, garantida no banco)
CREATE OR REPLACE FUNCTION ha_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registros de % não podem ser apagados. Use cancelamento.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER no_delete_accounts BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_orders BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_order_items BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_payments BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_discounts BEFORE DELETE ON discounts FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_cancellations BEFORE DELETE ON cancellations FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_cash_registers BEFORE DELETE ON cash_registers FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_audit_logs BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
-- Preço/nome/quantidade de item vendido nunca muda depois de gravado
CREATE OR REPLACE FUNCTION ha_freeze_item() RETURNS trigger AS $$
BEGIN
  IF NEW.unit_price_cents <> OLD.unit_price_cents OR NEW.quantity <> OLD.quantity
     OR NEW.product_name <> OLD.product_name THEN
    RAISE EXCEPTION 'Itens vendidos não podem ter preço, nome ou quantidade alterados. Cancele e lance novamente.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER freeze_order_items BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION ha_freeze_item();
--> statement-breakpoint
-- Só um caixa aberto por vez
CREATE UNIQUE INDEX one_open_register ON cash_registers (status) WHERE status = 'OPEN';
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_positive CHECK (amount_cents > 0);
--> statement-breakpoint
ALTER TABLE discounts ADD CONSTRAINT discounts_positive CHECK (amount_cents > 0);
--> statement-breakpoint
ALTER TABLE order_items ADD CONSTRAINT items_qty_positive CHECK (quantity > 0 AND unit_price_cents >= 0);
