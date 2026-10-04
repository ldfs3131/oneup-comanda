-- ONE UP Comanda 3.2 — Leva 1: PIN por pessoa, aparelhos da equipe, fiado com data combinada, acompanhamento do pedido,
-- consentimento de ofertas, compras no estoque e pendências. Tudo aditivo.

-- PIN de 4 dígitos (hash) e bloqueio por tentativas
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_falhas integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_bloqueado_ate timestamptz;
--> statement-breakpoint
-- Aparelhos da equipe: o PIN só funciona em aparelho onde alguém já entrou com usuário e senha
CREATE TABLE IF NOT EXISTS aparelhos (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  token_hash text NOT NULL UNIQUE,
  nome text,
  criado_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz,
  revogado_em timestamptz
);
--> statement-breakpoint
-- Fiado: data combinada para pagar e última cobrança (quem e quando)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS promised_date date;
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ultima_cobranca_em timestamptz;
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ultima_cobranca_por integer REFERENCES users(id);
--> statement-breakpoint
-- Pedido do cardápio digital: código aleatório para o cliente acompanhar (sem dado pessoal na página)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS public_token text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS orders_public_token_idx ON orders (public_token) WHERE public_token IS NOT NULL;
--> statement-breakpoint
-- Consentimento de ofertas pelo WhatsApp (texto exato e momento); sem ele nunca enviar promoção
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aceita_ofertas boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aceita_ofertas_em timestamptz;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aceita_ofertas_texto text;
--> statement-breakpoint
-- Entrada de compra: custo unitário e fornecedor no próprio movimento (histórico imutável)
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost_cents integer;
--> statement-breakpoint
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS fornecedor text;
--> statement-breakpoint
-- Pendências resolvidas (avulso repetido ignorado, divergência conferida): somem da lista
CREATE TABLE IF NOT EXISTS pendencias_resolvidas (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  tipo text NOT NULL CHECK (tipo IN ('avulso', 'divergencia')),
  chave text NOT NULL,
  acao text NOT NULL,
  user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, tipo, chave)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['aparelhos', 'pendencias_resolvidas'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'isolamento_empresa') THEN
      EXECUTE format('CREATE POLICY isolamento_empresa ON %I USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa())', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON aparelhos TO oneup_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON pendencias_resolvidas TO oneup_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE aparelhos_id_seq, pendencias_resolvidas_id_seq TO oneup_app;
