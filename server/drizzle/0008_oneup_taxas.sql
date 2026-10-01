-- ONE UP 3.0 — perfil da ONE UP dentro da empresa, taxa da maquininha e referência externa de vendas.

-- Usuário da ONE UP (Administrador da plataforma) dentro da empresa: o Dono não vê nem altera.
ALTER TABLE users ADD COLUMN IF NOT EXISTS oneup boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Taxa da maquininha por forma de pagamento, em centésimos de ponto percentual (428 = 4,28%).
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS taxa_bp integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_methods_taxa_bp_faixa') THEN
    ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_taxa_bp_faixa CHECK (taxa_bp BETWEEN 0 AND 2000);
  END IF;
END $$;
--> statement-breakpoint
-- Taxa CONGELADA no pagamento (como o custo do item): mudar a taxa depois não reescreve o passado.
-- NULL = pagamento anterior a este recurso (usa a taxa atual da forma).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS taxa_bp integer;
--> statement-breakpoint
-- Vendas de fora do sistema (ex.: relatório da maquininha antes da implantação), base de comparação da ONE UP.
CREATE TABLE IF NOT EXISTS referencias_externas (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  titulo text NOT NULL,
  origem text NOT NULL,
  inicio date NOT NULL,
  fim date NOT NULL CHECK (fim >= inicio),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  vendas integer NOT NULL CHECK (vendas >= 0),
  taxas_cents integer NOT NULL DEFAULT 0 CHECK (taxas_cents >= 0),
  por_forma jsonb NOT NULL DEFAULT '[]'::jsonb,
  observacao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, origem, inicio, fim)
);
--> statement-breakpoint
ALTER TABLE referencias_externas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE referencias_externas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'referencias_externas' AND policyname = 'isolamento_empresa') THEN
    CREATE POLICY isolamento_empresa ON referencias_externas USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa());
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT ON referencias_externas TO oneup_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON referencias_externas FROM oneup_app;
--> statement-breakpoint
-- A taxa congelada também não muda depois do pagamento.
CREATE OR REPLACE FUNCTION ha_freeze_payment() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.method_id IS DISTINCT FROM OLD.method_id
     OR NEW.tendered_cents IS DISTINCT FROM OLD.tendered_cents
     OR NEW.cash_register_id IS DISTINCT FROM OLD.cash_register_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.taxa_bp IS DISTINCT FROM OLD.taxa_bp THEN
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
