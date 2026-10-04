-- ONE UP Comanda 3.3 — Recuperação de vendas (CRM de cobrança do fiado). Só o acesso ONE UP usa; o Dono não vê.
-- Tudo aditivo e reaplicável.

-- Datas do "dia do restaurante" usadas pela régua e pelos guarda-corpos (1 contato por dia, alerta de baixa).
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS entrada_dia date;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS ultimo_contato_em timestamptz;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS ultimo_contato_dia date;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS contatos_no_dia integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS sem_resposta_seguidas integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS pago_informado_dia date;
--> statement-breakpoint
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS pausado_motivo text;
--> statement-breakpoint
-- contato que estava na conta quando foi marcado "número errado": quando o restaurante corrigir, a ficha volta sozinha
ALTER TABLE crm_cobrancas ADD COLUMN IF NOT EXISTS contato_errado text;
--> statement-breakpoint
-- Comprovante de pagamento (foto/PDF). Dado bancário: só a ONE UP vê; o arquivo fica fora da pasta pública
-- e pode ser apagado (o registro fica, com quem apagou e quando).
CREATE TABLE IF NOT EXISTS crm_comprovantes (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  cobranca_id integer NOT NULL REFERENCES crm_cobrancas(id),
  arquivo text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('png', 'jpg', 'webp', 'pdf')),
  tamanho integer NOT NULL CHECK (tamanho > 0),
  user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  apagado_em timestamptz,
  apagado_por integer REFERENCES users(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_comprovantes_cobranca_idx ON crm_comprovantes (empresa_id, cobranca_id);
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE 'ALTER TABLE crm_comprovantes ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE crm_comprovantes FORCE ROW LEVEL SECURITY';
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_comprovantes' AND policyname = 'isolamento_empresa') THEN
    EXECUTE 'CREATE POLICY isolamento_empresa ON crm_comprovantes USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa())';
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON crm_comprovantes TO oneup_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON crm_comprovantes FROM oneup_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE crm_comprovantes_id_seq TO oneup_app;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ref_crm_comprovantes ON crm_comprovantes;
--> statement-breakpoint
CREATE TRIGGER ref_crm_comprovantes BEFORE INSERT ON crm_comprovantes FOR EACH ROW EXECUTE FUNCTION ha_ref_mesma_empresa('cobranca_id', 'crm_cobrancas');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_cobrancas_conta_idx ON crm_cobrancas (empresa_id, account_id);
