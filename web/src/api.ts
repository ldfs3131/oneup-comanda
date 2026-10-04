export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) { super(message); }
}

const TIMEOUT_MS = 15_000;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function request<T>(method: string, path: string, body?: unknown, opts: { idem?: string | boolean; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (opts.idem) headers['idempotency-key'] = typeof opts.idem === 'string' ? opts.idem : newKey();
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin', headers, signal: ctrl.signal,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === 'AbortError') throw new ApiError(0, 'O servidor demorou para responder. Confira se a operação entrou antes de repetir (a tela vai atualizar sozinha).', 'TIMEOUT');
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique o Wi-Fi e o computador do caixa.', 'OFFLINE');
  }
  clearTimeout(timer);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) window.dispatchEvent(new Event('ha:unauthorized'));
    // restaurante suspenso pela ONE UP: volta para a tela de entrada, que mostra "Acesso suspenso — fale com a ONE UP"
    if (data?.code === 'LICENCA_SUSPENSA' && !path.startsWith('/api/auth/login')) window.dispatchEvent(new Event('ha:unauthorized'));
    throw new ApiError(res.status, data?.error ?? 'Erro inesperado.', data?.code, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b: unknown = {}, idem?: string | boolean, headers?: Record<string, string>) => request<T>('POST', p, b, { idem, headers }),
  put: <T,>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T,>(p: string) => request<T>('DELETE', p),
  upload: <T,>(p: string, fd: FormData) => request<T>('POST', p, fd),
  newKey,
};

/**
 * Chave anti-duplicidade que SOBREVIVE a um novo toque em "Enviar": se a internet falhou e a pessoa
 * reenvia exatamente o mesmo pedido, o servidor reconhece e não lança duas vezes. Muda quando o
 * conteúdo muda; zere (ref.current = null) depois que der certo.
 */
/** Identificador aleatório deste celular (sem dado pessoal): o limite de pedidos do cardápio é por aparelho. */
let aparelhoMem = '';
export function idAparelho() {
  try {
    let v = localStorage.getItem('oneup:aparelho');
    if (!v) { v = newKey().replace(/[^A-Za-z0-9_-]/g, ''); localStorage.setItem('oneup:aparelho', v); }
    return v;
  } catch {
    if (!aparelhoMem) aparelhoMem = newKey().replace(/[^A-Za-z0-9_-]/g, '');
    return aparelhoMem;
  }
}

export type ChaveEnvio = { current: { fp: string; key: string } | null };
export function chaveDoEnvio(ref: ChaveEnvio, conteudo: unknown) {
  const fp = JSON.stringify(conteudo);
  if (!ref.current || ref.current.fp !== fp) ref.current = { fp, key: newKey() };
  return ref.current.key;
}

export const qs = (o: Record<string, string | number | null | undefined | boolean>) => {
  const s = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `?${s}` : '';
};
