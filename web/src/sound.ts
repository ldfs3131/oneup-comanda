/** Sons gerados no navegador (sem arquivos) — funcionam offline. */
let ctx: AudioContext | null = null;
let unlocked = false;
const listeners = new Set<(v: boolean) => void>();

let muted = (() => { try { return localStorage.getItem('ha:muted') === '1'; } catch { return false; } })();
const muteListeners = new Set<(v: boolean) => void>();
export function isMuted() { return muted; }
export function setMuted(v: boolean) {
  muted = v;
  try { localStorage.setItem('ha:muted', v ? '1' : '0'); } catch { /* sem armazenamento */ }
  muteListeners.forEach((l) => l(v));
}
export function onMuteChange(fn: (v: boolean) => void) { muteListeners.add(fn); return () => { muteListeners.delete(fn); }; }

export function isAudioUnlocked() { return unlocked; }
export function onAudioUnlock(fn: (v: boolean) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export async function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    unlocked = ctx.state === 'running';
    listeners.forEach((l) => l(unlocked));
  } catch { /* navegador sem suporte */ }
  return unlocked;
}

function tone(freq: number, start: number, dur: number, vol = 0.35, type: OscillatorType = 'sine') {
  if (!ctx || muted) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Pedido pronto: "ding-dong" duplo, bem audível. */
export function playReady() {
  if (!unlocked) return;
  tone(988, 0, 0.35); tone(1319, 0.18, 0.5);
  tone(988, 0.8, 0.35); tone(1319, 0.98, 0.6);
}
/** Novo pedido na cozinha: bip curto. */
export function playNew() {
  if (!unlocked) return;
  tone(880, 0, 0.18, 0.4, 'square'); tone(880, 0.25, 0.18, 0.4, 'square');
}
/** Problema / cancelamento: tom grave. */
export function playAlert() {
  if (!unlocked) return;
  tone(330, 0, 0.3, 0.45, 'sawtooth'); tone(262, 0.32, 0.45, 0.45, 'sawtooth');
}
