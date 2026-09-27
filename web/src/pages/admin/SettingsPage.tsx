import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../../api';
import { useSettings } from '../../components/layout';
import { Spinner, Toggle, useAction } from '../../components/ui';

export default function SettingsPage() {
  const { data } = useSettings();
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [wa, setWa] = useState<string | null>(null);
  const [backup, setBackup] = useState<{ dir: string; ok: boolean; file?: string; error?: string }[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const lan = data?.lanUrls;
  const menuUrl = `${lan?.[0] ?? window.location.origin}/cardapio`;
  useEffect(() => { QRCode.toDataURL(menuUrl, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(null)); }, [menuUrl]);

  if (!data) return <Spinner />;
  const set = (body: object, msg: string) => run(async () => { await api.patch('/api/settings', body); qc.invalidateQueries({ queryKey: ['settings'] }); }, msg);

  return (
    <div className="col gap-lg page narrow" style={{ padding: 0 }}>
      <h1>Configurações</h1>

      <div className="card col gap-lg">
        <SettingRow title="Restaurante" desc="Controle manual. Quando fechado, o cardápio digital não aceita pedidos." on={data.restaurant.isOpen}
          onLabel="🟢 ABERTO" offLabel="🔴 FECHADO" onChange={(v) => set({ isOpen: v }, v ? 'Restaurante aberto.' : 'Restaurante fechado.')} busy={busy} />
        <div className="divider" style={{ margin: 0 }} />
        <SettingRow title="Delivery" desc="Controle manual. Sem logística de entrega na V1 — só libera a opção “Entrega” no cardápio digital." on={data.delivery.isOpen}
          onLabel="🟢 ABERTO" offLabel="🔴 FECHADO" onChange={(v) => set({ deliveryOpen: v }, v ? 'Delivery aberto.' : 'Delivery fechado.')} busy={busy} />
      </div>

      <div className="card col gap-lg">
        <SettingRow title="Cardápio digital (QR Code)" desc="Pronto, mas desligado na implantação. Quando ligado, pedidos do cliente chegam ao caixa para confirmação antes da cozinha." on={data.restaurant.qrEnabled}
          onLabel="Ligado" offLabel="Desligado" onChange={(v) => set({ qrEnabled: v }, v ? 'Cardápio digital ligado.' : 'Cardápio digital desligado.')} busy={busy} />
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
        <div>
          <b>Backup</b>
          <div className="small muted">Automático a cada fechamento de caixa. Pastas configuradas: {data.backupDirs.length ? data.backupDirs.join(' · ') : <span style={{ color: 'var(--danger)' }}>nenhuma (configure BACKUP_DIRS no arquivo .env)</span>}</div>
        </div>
        <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(async () => { const r = await api.post<{ results: any[] }>('/api/backup'); setBackup(r.results); })}>💾 Fazer backup agora</button>
        {backup && backup.map((b, i) => (
          <div key={i} className={`small ${b.ok ? '' : 'cancel-text'}`}>{b.ok ? `✔ Salvo em ${b.file}` : `✘ ${b.dir}: ${b.error}`}</div>
        ))}
      </div>
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
