/**
 * Browser storage (IndexedDB) for additional graph files. Legacy local-paper
 * helpers retain access to older browser data; the Library uses server records.
 */
export interface GraphSource {
  file: string;
  label?: string;
  provenance?: string;
  url?: string;
  json?: unknown;
}
export interface PaperSource {
  id: string;
  title: string;
  subtitle?: string;
  pdfUrl?: string;
  arxivPage?: string;
  pdfBytes?: ArrayBuffer;
  graphs: GraphSource[];
  user?: boolean;
}

const DB = "pdf-mira";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export const idbGet = <T>(k: string) => tx<T | undefined>("readonly", (s) => s.get(k) as IDBRequest<T | undefined>).catch(() => undefined);
export const idbSet = (k: string, v: unknown) => tx("readwrite", (s) => s.put(v, k)).then(() => true, () => false);
export const idbDel = (k: string) => tx("readwrite", (s) => s.delete(k)).then(() => true, () => false);

export async function listUserPapers(): Promise<PaperSource[]> {
  return (await idbGet<PaperSource[]>("papers")) ?? [];
}
export async function saveUserPaper(p: PaperSource): Promise<boolean> {
  const all = (await listUserPapers()).filter((x) => x.id !== p.id);
  return idbSet("papers", [...all, { ...p, user: true }]);
}
export async function deleteUserPaper(id: string) {
  const all = (await listUserPapers()).filter((x) => x.id !== id);
  await idbSet("papers", all);
  await idbDel(`extra:${id}`);
}
export async function extraGraphs(paperId: string): Promise<GraphSource[]> {
  return (await idbGet<GraphSource[]>(`extra:${paperId}`)) ?? [];
}
export async function addExtraGraph(paperId: string, g: GraphSource) {
  const cur = (await extraGraphs(paperId)).filter((x) => x.file !== g.file);
  return idbSet(`extra:${paperId}`, [...cur, g]);
}
