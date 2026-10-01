-- ONE Food 3.0 — ONE Base: várias empresas no mesmo banco, isoladas pelo próprio PostgreSQL (RLS).
-- Aditiva: um banco existente (instalação de um restaurante) vira a EMPRESA Nº 1 sem mover nenhum dado.

-- 1) Empresa da conexão atual. Sem empresa definida = NULL = nenhuma linha visível (nega tudo).
CREATE OR REPLACE FUNCTION app_empresa() RETURNS integer
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.empresa_id', true), '')::integer $$;
--> statement-breakpoint

-- 2) Cadastro das empresas da plataforma
CREATE TABLE IF NOT EXISTS empresas (
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  nome text NOT NULL,
  produto text NOT NULL DEFAULT 'food',
  status text NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'IMPLANTACAO', 'SUSPENSA', 'CANCELADA', 'TESTE', 'CORTESIA')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO empresas (id, slug, nome)
  SELECT 1, 'empresa-1', COALESCE((SELECT name FROM restaurant_settings ORDER BY id LIMIT 1), 'Empresa 1')
  WHERE NOT EXISTS (SELECT 1 FROM empresas WHERE id = 1);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('empresas', 'id'), GREATEST((SELECT MAX(id) FROM empresas), 1));
--> statement-breakpoint

-- 3) empresa_id em toda tabela com dados de empresa (só "roles" é global).
--    Linhas existentes recebem 1; depois o padrão passa a vir da conexão (ninguém digita empresa_id).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sessions','categories','products','option_groups','options','cash_registers','cash_movements',
    'accounts','orders','order_items','payment_methods','payments','discounts','cancellations','audit_logs',
    'restaurant_settings','delivery_settings','counters','customers','product_costs','stock_movements',
    'expense_categories','expenses','status_events','excluded_days','order_time_corrections','idempotency_keys','insight_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS empresa_id integer NOT NULL DEFAULT 1 REFERENCES empresas(id)', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN empresa_id SET DEFAULT app_empresa()', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (empresa_id)', t || '_empresa_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'isolamento_empresa') THEN
      EXECUTE format('CREATE POLICY isolamento_empresa ON %I USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa())', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- 4) Configurações: uma linha por empresa (a chave passa a ser a própria empresa)
ALTER TABLE restaurant_settings ALTER COLUMN id SET DEFAULT app_empresa();
--> statement-breakpoint
ALTER TABLE delivery_settings ALTER COLUMN id SET DEFAULT app_empresa();
--> statement-breakpoint
ALTER TABLE restaurant_settings ALTER COLUMN name SET DEFAULT 'Meu restaurante';
--> statement-breakpoint
ALTER TABLE restaurant_settings ALTER COLUMN tagline SET DEFAULT '';
--> statement-breakpoint

-- 5) Unicidades passam a valer por empresa
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_number_unique;
--> statement-breakpoint
ALTER TABLE accounts ADD CONSTRAINT accounts_empresa_number_unique UNIQUE (empresa_id, number);
--> statement-breakpoint
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_number_unique;
--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_empresa_number_unique UNIQUE (empresa_id, number);
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_empresa_username_unique UNIQUE (empresa_id, username);
--> statement-breakpoint
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_code_unique;
--> statement-breakpoint
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_empresa_code_unique UNIQUE (empresa_id, code);
--> statement-breakpoint
ALTER TABLE expense_categories DROP CONSTRAINT IF EXISTS expense_categories_name_unique;
--> statement-breakpoint
ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_empresa_name_unique UNIQUE (empresa_id, name);
--> statement-breakpoint
ALTER TABLE counters DROP CONSTRAINT IF EXISTS counters_pkey;
--> statement-breakpoint
ALTER TABLE counters ADD CONSTRAINT counters_pkey PRIMARY KEY (empresa_id, name);
--> statement-breakpoint
ALTER TABLE excluded_days DROP CONSTRAINT IF EXISTS excluded_days_pkey;
--> statement-breakpoint
ALTER TABLE excluded_days ADD CONSTRAINT excluded_days_pkey PRIMARY KEY (empresa_id, day);
--> statement-breakpoint

-- um caixa aberto POR EMPRESA (antes: um só no sistema inteiro)
DROP INDEX IF EXISTS one_open_register;
--> statement-breakpoint
CREATE UNIQUE INDEX one_open_register ON cash_registers (empresa_id) WHERE status = 'OPEN';
--> statement-breakpoint

-- 6) Papel de banco da aplicação: NÃO ignora RLS. A aplicação conecta com este papel;
--    migrações e tarefas de sistema usam o usuário dono do banco, num ponto único do código.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onefood_app') THEN
    CREATE ROLE onefood_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
GRANT onefood_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO onefood_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onefood_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON roles, empresas FROM onefood_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO onefood_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO onefood_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO onefood_app;
--> statement-breakpoint
-- A aplicação só enxerga a própria empresa no cadastro de empresas
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE empresas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY empresa_propria ON empresas FOR SELECT USING (id = app_empresa());

--> statement-breakpoint
-- 7) Vínculos sempre dentro da mesma empresa. A chave estrangeira do PostgreSQL NÃO olha o RLS;
--    esta trava confere, com o RLS ligado, se o registro apontado é visível para a empresa atual.
CREATE OR REPLACE FUNCTION ha_ref_mesma_empresa() RETURNS trigger AS $$
DECLARE i int; col text; tab text; val bigint; ok boolean;
BEGIN
  FOR i IN 0 .. (TG_NARGS / 2 - 1) LOOP
    col := TG_ARGV[i * 2]; tab := TG_ARGV[i * 2 + 1];
    EXECUTE format('SELECT ($1).%I', col) INTO val USING NEW;
    IF val IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', tab) INTO ok USING val;
      IF NOT ok THEN
        RAISE EXCEPTION 'Referência inválida (% %).', tab, val USING ERRCODE = 'foreign_key_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ref_products BEFORE INSERT OR UPDATE OF category_id ON products FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('category_id', 'categories');
--> statement-breakpoint
CREATE TRIGGER ref_option_groups BEFORE INSERT OR UPDATE OF product_id ON option_groups FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('product_id', 'products');
--> statement-breakpoint
CREATE TRIGGER ref_options BEFORE INSERT OR UPDATE OF group_id ON options FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('group_id', 'option_groups');
--> statement-breakpoint
CREATE TRIGGER ref_accounts BEFORE INSERT OR UPDATE OF customer_id, merged_into ON accounts FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('customer_id', 'customers', 'merged_into', 'accounts');
--> statement-breakpoint
CREATE TRIGGER ref_orders BEFORE INSERT OR UPDATE OF account_id ON orders FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('account_id', 'accounts');
--> statement-breakpoint
CREATE TRIGGER ref_order_items BEFORE INSERT OR UPDATE OF order_id, product_id ON order_items FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('order_id', 'orders', 'product_id', 'products');
--> statement-breakpoint
CREATE TRIGGER ref_payments BEFORE INSERT OR UPDATE OF account_id, method_id, cash_register_id ON payments FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('account_id', 'accounts', 'method_id', 'payment_methods', 'cash_register_id', 'cash_registers');
--> statement-breakpoint
CREATE TRIGGER ref_discounts BEFORE INSERT OR UPDATE OF account_id ON discounts FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('account_id', 'accounts');
--> statement-breakpoint
CREATE TRIGGER ref_cancellations BEFORE INSERT OR UPDATE OF account_id ON cancellations FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('account_id', 'accounts', 'order_id', 'orders', 'order_item_id', 'order_items');
--> statement-breakpoint
CREATE TRIGGER ref_expenses BEFORE INSERT OR UPDATE OF category_id ON expenses FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('category_id', 'expense_categories');
--> statement-breakpoint
CREATE TRIGGER ref_stock_movements BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('product_id', 'products');
--> statement-breakpoint
CREATE TRIGGER ref_product_costs BEFORE INSERT ON product_costs FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('product_id', 'products');
--> statement-breakpoint
CREATE TRIGGER ref_time_corrections BEFORE INSERT ON order_time_corrections FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('order_id', 'orders');
--> statement-breakpoint
CREATE TRIGGER ref_sessions BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('user_id', 'users');
