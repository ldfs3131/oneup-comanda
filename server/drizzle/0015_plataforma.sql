-- ONE UP Comanda 3.3 — Plataforma ONE UP: licença online por restaurante, mensalidade e histórico de cobrança.
-- Aditiva e reaplicável. Empresas que já existem (o restaurante piloto) ficam ATIVO e SEM vencimento:
-- nenhum relógio as coloca em "só consulta".

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS licenca_status text NOT NULL DEFAULT 'ATIVO';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresas_licenca_status_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT empresas_licenca_status_check CHECK (licenca_status IN ('ATIVO', 'SO_CONSULTA', 'SUSPENSO'));
  END IF;
END $$;
--> statement-breakpoint
-- último dia em que a licença vale (nulo = sem vencimento)
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS licenca_vence_em date;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS mensalidade_cents integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresas_mensalidade_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT empresas_mensalidade_check CHECK (mensalidade_cents >= 0);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plano text;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS dono_nome text;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS dono_whatsapp text;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cobranca_enviada_em timestamptz;
--> statement-breakpoint
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS observacao text;
--> statement-breakpoint
-- Caixa aberto em "só consulta" apenas para receber contas abertas (sem pedido novo, estabelecimento fechado)
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS somente_receber boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Histórico de licença e cobrança da plataforma (sem RLS: só o pool de sistema lê e grava; o restaurante não vê)
CREATE TABLE IF NOT EXISTS plataforma_historico (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL REFERENCES empresas(id),
  tipo text NOT NULL,
  antes jsonb,
  depois jsonb,
  mensagem text NOT NULL,
  usuario text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plataforma_historico_empresa_idx ON plataforma_historico (empresa_id, created_at DESC);
--> statement-breakpoint
REVOKE ALL ON plataforma_historico FROM oneup_app;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE plataforma_historico_id_seq FROM oneup_app;
