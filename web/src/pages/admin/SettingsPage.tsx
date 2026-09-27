import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../../api';
import { OneUpCredit, useSettings } from '../../components/layout';
import { MoneyInput, Spinner, Toggle, useAction } from '../../components/ui';

export default function SettingsPage() {
  const { data } = useSettings();
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [wa, setWa] = useState<string | null>(null);
  const [backup, setBackup] = useState<{ dir: string; ok: boolean; file?: string; error?: string }[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [tagline, setTagline] = useState<string | null>(null);
  const [mei, setMei] = useState<number | null | undefined>(undefined);

  const lan = data?.lanUrls;
  const menuUrl = `${lan?.[0] ?? window.location.origin}/cardapio`;
  useEffect(() => { QRCode.toDataURL(menuUrl, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(null)); }, [menuUrl]);

  if (!data) return <Spinner />;
  const set = (body: object, msg: string) => run(async () => { await api.patch('/api/settings', body); qc.invalidateQueries({ queryKey: ['settings'] }); }, msg);

  return (
    <div className="col gap-lg page narrow" style={{ padding: 0 }}>
      <h1>Configurações</h1>

      <div className="card col gap-lg">
        <div>
          <b>Identidade</b>
          <div className="small muted">Aparece no login e nas telas. O logotipo fica no arquivo logo.png.</div>
        </div>
        <div className="grid-2">
          <label className="field"><span>Nome do estabelecimento</span><input className="input" value={name ?? data.restaurant.name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
          <label className="field"><span>Subtítulo</span><input className="input" value={tagline ?? data.restaurant.tagline ?? ''} onChange={(e) => setTagline(e.target.value)} maxLength={60} /></label>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy || (name == null && tagline == null) || (name != null && name.trim().length < 2)} onClick={async () => {
          const body: Record<string, string> = {};
          if (name != null) body.name = name.trim();
          if (tagline != null) body.tagline = tagline.trim();
          if (await set(body, 'Identidade salva.')) { setName(null); setTagline(null); }
        }}>Salvar identidade</button>
      </div>

      <div className="card col gap-lg">
        <SettingRow title="Estabelecimento" desc="Mesmo botão ABERTO/FECHADO do caixa (estado único, em tempo real). Fechado: sem pedidos novos, mas dá para consultar e receber. “Abrir o dia” abre; “Encerrar o dia” fecha." on={data.restaurant.isOpen}
          onLabel="🟢 ABERTO" offLabel="🔴 FECHADO" onChange={(v) => set({ isOpen: v }, v ? 'Estabelecimento aberto.' : 'Estabelecimento fechado.')} busy={busy} />
        <div className="divider" style={{ margin: 0 }} />
        <SettingRow title="Delivery" desc="Controle manual. Sem logística de entrega — só libera a opção “Entrega” no cardápio digital." on={data.delivery.isOpen}
          onLabel="🟢 ABERTO" offLabel="🔴 FECHADO" onChange={(v) => set({ deliveryOpen: v }, v ? 'Delivery aberto.' : 'Delivery fechado.')} busy={busy} />
      </div>

      <div className="card col gap-lg">
        <SettingRow title="Cardápio digital (QR Code)" desc="Pronto, mas desligado na implantação. Quando ligado, pedidos do cliente chegam ao caixa para confirmação antes da cozinha." on={data.restaurant.qrEnabled}
          onLabel="Ligado" offLabel="Desligado" onChange={(v) => set({ qrEnabled: v }, v ? 'Cardápio digital ligado.' : 'Cardápio digital desligado.')} busy={busy} />
        {data.publicPort
          ? <div className="info-box small">Porta pública separada ativa: <b>{data.publicPort}</b> (só cardápio e pedidos do cliente). Para clientes no 4G, publique essa porta com o Tailscale Funnel — veja o guia de instalação. Todo pedido do cliente passa pela confirmação do caixa.</div>
          : <div className="small faint">Porta pública separada desligada (PUBLIC_PORT no .env). Sem ela, o cardápio só funciona no Wi-Fi do restaurante.</div>}
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
          {qr && <img src={qr} alt="QR Code do cardápio" style={{ width: 160, height: 160, borderRadius: 10, background: '#fff', padding: 6 }} />}
          <div className="col grow">
            <div className="small muted">Endereço do cardápio:</div>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{menuUrl}</div>
            <div className="small faint">Com o servidor no computador do caixa, o QR Code só funciona para quem estiver conectado ao Wi-Fi do restaurante. Para clientes no 4G, o sistema precisa estar na internet (fase futura).</div>
            <a className="btn sm" style={{ alignSelf: 'flex-start' }} href="/cardapio" target="_blank" rel="noreferrer">Ver cardápio digital</a>
          </div>
        </div>
      </div>

      <div className="card col gap-lg">
        <div>
          <b>WhatsApp oficial</b>
          <div className="small muted">Usado no botão “Pedir pelo WhatsApp” do cardápio digital. Só números, com DDD.</div>
        </div>
        <div className="row">
          <input className="input" style={{ maxWidth: 260 }} inputMode="tel" placeholder="61999990000" value={wa ?? data.restaurant.whatsappNumber ?? ''} onChange={(e) => setWa(e.target.value)} />
          <button className="btn primary" disabled={busy || wa == null} onClick={async () => { if (await set({ whatsappNumber: wa }, 'WhatsApp salvo.')) setWa(null); }}>Salvar</button>
        </div>
      </div>

      <div className="card col gap-lg">
        <SettingRow title="Indicador do MEI" desc="Mostra no dashboard quanto do limite anual do MEI já foi faturado no sistema. Referência: confirme o limite vigente com o contador." on={data.restaurant.meiEnabled}
          onLabel="Ligado" offLabel="Desligado" onChange={(v) => set({ meiEnabled: v }, v ? 'Indicador do MEI ligado.' : 'Indicador do MEI desligado.')} busy={busy} />
        {data.restaurant.meiEnabled && (
          <div className="row wrap">
            <label className="field" style={{ maxWidth: 260 }}><span>Limite anual de referência</span><MoneyInput value={mei === undefined ? data.restaurant.meiLimitCents : mei} onChange={setMei} /></label>
            <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy || mei == null} onClick={async () => { if (await set({ meiLimitCents: mei }, 'Limite salvo.')) setMei(undefined); }}>Salvar</button>
          </div>
        )}
      </div>

      <div className="card col gap-lg">
        <div>
          <b>Backup</b>
          <div className="small muted">Automático a cada “Encerrar o dia”. Pastas configuradas: {data.backupDirs.length ? data.backupDirs.join(' · ') : <span style={{ color: 'var(--danger)' }}>nenhuma (configure BACKUP_DIRS no arquivo .env)</span>}</div>
        </div>
        <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(async () => { const r = await api.post<{ results: any[] }>('/api/backup'); setBackup(r.results); })}>💾 Fazer backup agora</button>
        {backup && backup.map((b, i) => (
          <div key={i} className={`small ${b.ok ? '' : 'cancel-text'}`}>{b.ok ? `✔ Salvo em ${b.file}` : `✘ ${b.dir}: ${b.error}`}</div>
        ))}
      </div>
      <div className="center"><OneUpCredit version={data.version} /></div>
    </div>
  );
}

function SettingRow({ title, desc, on, onLabel, offLabel, onChange, busy }: {
  title: string; desc: string; on: boolean; onLabel: string; offLabel: string; onChange: (v: boolean) => void; busy: boolean;
}) {
  return (
    <div className="row between" style={{ gap: 16 }}>
      <div className="grow">
        <b>{title}</b>
        <div className="small muted">{desc}</div>
      </div>
      <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{on ? onLabel : offLabel}</span>
      <Toggle on={on} onChange={onChange} disabled={busy} label={title} />
    </div>
  );
}
