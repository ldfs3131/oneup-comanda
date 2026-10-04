-- ONE UP Comanda 3.3 — versão Happy Alpha: suporte liberado pelo Dono, motivo de recusa para o cliente,
-- recontagem do caixa, clientes (LGPD: revogar ofertas, anonimizar). Tudo aditivo e reaplicável.

-- "Permitir suporte": a ONE UP só vê nome e telefone de clientes quando o Dono libera (30 min, 2 h ou 24 h)
CREATE TABLE IF NOT EXISTS suporte_liberacoes (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  ate timestamptz NOT NULL,
  criado_por integer REFERENCES users(id),
  encerrado_em timestamptz,
  encerrado_por integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Recusa de pedido online: o cliente vê só o motivo da lista (o texto do caixa fica interno)
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS motivo_cliente text;
--> statement-breakpoint
-- Fechamento às cegas com UMA recontagem: guarda a primeira contagem
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS primeira_contagem_cents integer;
--> statement-breakpoint
-- Clientes (LGPD): revogação de ofertas e anonimização (as vendas continuam)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ofertas_revogadas_em timestamptz;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS anonimizado_em timestamptz;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS juntado_em integer REFERENCES customers(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_telefone_idx ON customers (empresa_id, phone) WHERE phone IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE suporte_liberacoes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE suporte_liberacoes FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'suporte_liberacoes' AND policyname = 'isolamento_empresa') THEN
    CREATE POLICY isolamento_empresa ON suporte_liberacoes USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa());
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON suporte_liberacoes TO oneup_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE suporte_liberacoes_id_seq TO oneup_app;
