-- ONE UP 3.0 — Personalização pelo Dono: valores por empresa, histórico imutável e cadeados da ONE UP.

-- Valor de cada configuração da empresa (só o que foi alterado; o resto usa o padrão do catálogo em código)
CREATE TABLE IF NOT EXISTS empresa_config (
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  chave text NOT NULL,
  valor jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id),
  PRIMARY KEY (empresa_id, chave)
);
--> statement-breakpoint
-- Histórico de toda mudança (quem, antes, depois, quando, origem). Nunca se edita nem se apaga.
CREATE TABLE IF NOT EXISTS config_historico (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  chave text NOT NULL,
  antes jsonb,
  depois jsonb,
  origem text NOT NULL CHECK (origem IN ('EMPRESA', 'PADRAO', 'ONEUP')),
  user_id integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS config_historico_empresa_chave_idx ON config_historico (empresa_id, chave, id DESC);
--> statement-breakpoint
-- Cadeado da ONE UP: configuração travada por empresa, com motivo. A aplicação só LÊ.
CREATE TABLE IF NOT EXISTS config_travas (
  empresa_id integer NOT NULL DEFAULT app_empresa() REFERENCES empresas(id),
  chave text NOT NULL,
  motivo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, chave)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['empresa_config', 'config_historico', 'config_travas'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'isolamento_empresa') THEN
      EXECUTE format('CREATE POLICY isolamento_empresa ON %I USING (empresa_id = app_empresa()) WITH CHECK (empresa_id = app_empresa())', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON empresa_config TO oneup_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON config_historico TO oneup_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE config_historico_id_seq TO oneup_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON config_historico FROM oneup_app;
--> statement-breakpoint
GRANT SELECT ON config_travas TO oneup_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON config_travas FROM oneup_app;
--> statement-breakpoint
CREATE TRIGGER no_update_config_historico BEFORE UPDATE ON config_historico FOR EACH ROW EXECUTE FUNCTION ha_block_update();
--> statement-breakpoint
CREATE TRIGGER no_delete_config_historico BEFORE DELETE ON config_historico FOR EACH ROW EXECUTE FUNCTION ha_block_delete();
--> statement-breakpoint
CREATE TRIGGER no_truncate_config_historico BEFORE TRUNCATE ON config_historico FOR EACH STATEMENT EXECUTE FUNCTION ha_block_truncate();
--> statement-breakpoint

-- Instalações que já existiam mantêm a aparência de antes (cor e logotipo do pacote anterior)
INSERT INTO empresa_config (empresa_id, chave, valor)
  SELECT e.id, v.chave, v.valor FROM empresas e
  CROSS JOIN (VALUES ('cor_destaque', '"#f2d38a"'::jsonb), ('logo', '"/logo.png"'::jsonb)) AS v(chave, valor)
  WHERE e.id = 1 AND EXISTS (SELECT 1 FROM users u WHERE u.empresa_id = 1)
ON CONFLICT DO NOTHING;
