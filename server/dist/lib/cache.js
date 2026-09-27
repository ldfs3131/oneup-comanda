/** Versão dos dados operacionais: muda a cada pedido/pagamento. Usada para invalidar caches (ex.: insights). */
let version = 0;
export const bumpDataVersion = () => { version++; };
export const dataVersion = () => version;
