CREATE TRIGGER no_delete_stock_movements BEFORE DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_expenses BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_product_costs BEFORE DELETE ON product_costs FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_status_events BEFORE DELETE ON status_events FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_time_corrections BEFORE DELETE ON order_time_corrections FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_delete_cash_movements BEFORE DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ha_freeze_item() RETURNS trigger AS $$
BEGIN
  IF NEW.unit_price_cents <> OLD.unit_price_cents OR NEW.quantity <> OLD.quantity
     OR NEW.product_name <> OLD.product_name THEN
    RAISE EXCEPTION 'Itens vendidos não podem ter preço, nome ou quantidade alterados. Cancele e lance novamente.';
  END IF;
  IF OLD.unit_cost_cents IS NOT NULL AND NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents THEN
    RAISE EXCEPTION 'O custo registrado na venda não pode ser alterado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_stock_nonneg CHECK (stock_qty >= 0);
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_prep_range CHECK (prep_minutes BETWEEN 1 AND 240);
--> statement-breakpoint
ALTER TABLE products ADD CONSTRAINT products_cost_nonneg CHECK (cost_cents IS NULL OR cost_cents >= 0);
--> statement-breakpoint
ALTER TABLE expenses ADD CONSTRAINT expenses_positive CHECK (amount_cents > 0);
--> statement-breakpoint
ALTER TABLE options ADD CONSTRAINT options_stock_product_fk FOREIGN KEY (stock_product_id) REFERENCES products(id);
--> statement-breakpoint
CREATE INDEX orders_created_idx ON orders (created_at);
--> statement-breakpoint
CREATE INDEX payments_created_idx ON payments (created_at);
--> statement-breakpoint
INSERT INTO expense_categories (name, sort_order) VALUES
 ('Funcionários',1),('Combustível',2),('Energia',3),('Água',4),('Taxas',5),('Compras',6),
 ('Limpeza',7),('Manutenção',8),('Embalagens',9),('Entrega',10),('Comunicação',11),('Outros',12)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
-- Custo inicial: produtos existentes sem custo seguem sem custo (null). Linha do tempo aberto/fechado começa com o estado atual.
INSERT INTO status_events (is_open, created_at) SELECT is_open, now() FROM restaurant_settings WHERE id = 1;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION unaccent_lower(t text) RETURNS text IMMUTABLE LANGUAGE sql AS $$
  SELECT translate(lower(coalesce(t, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
$$;
