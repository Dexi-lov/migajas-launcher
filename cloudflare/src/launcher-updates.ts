import {signatureEnvelope} from '../../supabase/functions/_shared/update-signature';
import { createClient } from '@supabase/supabase-js';
import type { D1Database } from '@cloudflare/workers-types';
type Env = { DB: D1Database; SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string; SUPABASE_PUBLIC_KEY: string; VERIFIER_SECRET?: string; UPDATER_PUBLIC_KEY?: string };
const client = (env: Env) => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = (env: Env) => client(env).storage.from('migajas-launcher-updates');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; return 0; };
const rows = async (env: Env, sql: string, ...values: unknown[]) => (await env.DB.prepare(sql).bind(...values).all<Record<string, any>>()).results;
export async function cleanupLauncherUpdates(env: Env) {
  const stale = new Date(Date.now() - 24 * 3600000).toISOString();
  await env.DB.prepare("UPDATE migajas_launcher_updates SET status='retired' WHERE status='staging' AND created_at<?").bind(stale).run();
  const pending = await rows(env, "SELECT id,storage_path,created_at,published_at FROM migajas_launcher_updates WHERE status='retired'");
  for (const row of pending) {
    const { error } = await bucket(env).remove([row.storage_path]);
    if (!error && (row.published_at || row.created_at < stale)) await env.DB.prepare("DELETE FROM migajas_launcher_updates WHERE id=? AND status='retired'").bind(row.id).run();
  }
  return (await rows(env, "SELECT id FROM migajas_launcher_updates WHERE status='retired' AND published_at IS NOT NULL")).length;
}
export async function launcherUpdateAction(env: Env, uuid: string, p: any) {
  if (p.action === 'admin_update_status') {
    const cleanupPending = await cleanupLauncherUpdates(env);
    const active = await env.DB.prepare("SELECT version,notes,published_at FROM migajas_launcher_updates WHERE status='active'").first();
    return { active, cleanupPending: cleanupPending > 0 };
  }
  if (p.action === 'admin_update_begin') {
    await cleanupLauncherUpdates(env);
    const version = String(p.version || ''), notes = String(p.notes || '').trim(), signatureInput = String(p.signature || '').trim(), size = Number(p.size), sha256 = String(p.sha256 || '');
    if (!stableVersion.test(version) || version.split('.').some(n => Number(n)>65535)) throw new Error('Escribe una versión como 1.2.14.');
    if (!notes || notes.length > 6000) throw new Error('Explica las novedades con palabras sencillas, en un máximo de 6000 caracteres.');
    if (!signatureInput || signatureInput.length > 16384 || !Number.isSafeInteger(size) || size < 1024 || size > 52428800 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Selecciona un instalador EXE de hasta 50 MiB y su archivo de firma .sig.');
    if(!env.UPDATER_PUBLIC_KEY)throw new Error('La clave pública del actualizador no está configurada.');
    const signature=signatureEnvelope(signatureInput,env.UPDATER_PUBLIC_KEY).canonical;
    const active = await env.DB.prepare("SELECT version FROM migajas_launcher_updates WHERE status='active'").first<{ version: string }>();
    if (active && compare(version, active.version) <= 0) throw new Error('La versión nueva debe ser mayor que la publicada.');
    const parts=version.split('.').map(Number),rank=parts[0]*4294967296+parts[1]*65536+parts[2];
    const id = crypto.randomUUID(), path = `${id}/MigajasLauncher-${version}.exe`;
    const { data, error } = await bucket(env).createSignedUploadUrl(path);
    if (error || !data) throw new Error('No se pudo preparar la subida de la actualización.');
    await env.DB.prepare("INSERT INTO migajas_launcher_updates(id,version,version_rank,storage_path,byte_size,sha256,signature,notes,status,uploader_uuid,created_at) VALUES(?,?,?,?,?,?,?,?,'staging',?,?)").bind(id, version, rank, path, size, sha256, signature, notes, uuid, new Date().toISOString()).run();
    return { uploadId: id, path, token: data.token };
  }
  const id = String(p.uploadId || '');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Selecciona una subida válida.');
  const update = await env.DB.prepare("SELECT * FROM migajas_launcher_updates WHERE id=? AND uploader_uuid=? AND status='staging'").bind(id, uuid).first<Record<string, any>>();
  if (!update) throw new Error('La subida no está disponible. Iníciala otra vez.');
  if (p.action === 'admin_update_cancel') {
    await env.DB.prepare("UPDATE migajas_launcher_updates SET status='retired' WHERE id=? AND status='staging'").bind(id).run();
    await cleanupLauncherUpdates(env);
    return { success: true };
  }
  if (!env.VERIFIER_SECRET || !env.UPDATER_PUBLIC_KEY) throw new Error('La verificación de firma del servidor no está configurada.');
  const response = await fetch(env.SUPABASE_URL + '/functions/v1/migajas-verify-update', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + env.SUPABASE_PUBLIC_KEY, 'x-migajas-verifier-secret': env.VERIFIER_SECRET }, body: JSON.stringify({ path: update.storage_path, size: update.byte_size, sha256: update.sha256, signature: update.signature, publicKey: env.UPDATER_PUBLIC_KEY, version: update.version }), signal: AbortSignal.timeout(120000) });
  const checked = await response.json() as { valid?: boolean; signature?: string; error?: string };
  if (!response.ok || !checked.valid || !checked.signature) throw new Error(checked.error || 'La actualización no pasó la verificación. La anterior sigue publicada.');
  // The conditional activation also prevents a slower upload from replacing a newer release.
  const newer = await env.DB.prepare("SELECT version FROM migajas_launcher_updates WHERE status='active'").first<{ version: string }>();
  if (newer && compare(update.version, newer.version) <= 0) throw new Error('Otra persona ya publicó una versión igual o más reciente.');
  const published = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE migajas_launcher_updates SET status='retired' WHERE status='active' AND version_rank<? AND EXISTS(SELECT 1 FROM migajas_launcher_updates WHERE id=? AND status='staging')").bind(update.version_rank,id),
    env.DB.prepare("UPDATE migajas_launcher_updates SET status='active',signature=?,published_at=? WHERE id=? AND status='staging' AND NOT EXISTS(SELECT 1 FROM migajas_launcher_updates WHERE status='active')").bind(checked.signature, published, id),
    env.DB.prepare("INSERT INTO migajas_audit(actor_uuid,action,target,created_at) SELECT ?,'launcher_update',?,? FROM migajas_launcher_updates WHERE id=? AND status='active'").bind(uuid, update.version, published, id)
  ]);
  if(!(await env.DB.prepare("SELECT 1 FROM migajas_launcher_updates WHERE id=? AND status='active'").bind(id).first()))throw new Error('Otra persona publicó una versión más reciente. La versión actual se conserva.');
  const cleanupPending = await cleanupLauncherUpdates(env);
  return { success: true, version: update.version, cleanupPending: cleanupPending > 0 };
}
export async function publicLauncherUpdate(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url), manifest = url.pathname.match(/^\/updater\/windows\/x86_64\/(\d+\.\d+\.\d+)$/), download = url.pathname.match(/^\/updates\/([a-f0-9-]{36})\/download$/);
  const currentInfo=url.pathname==='/updates/current';
  if (!manifest && !download && !currentInfo) return null;
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  const active = await env.DB.prepare("SELECT * FROM migajas_launcher_updates WHERE status='active'").first<Record<string, any>>();
  if(currentInfo)return active?Response.json({version:active.version,notes:active.notes,pub_date:active.published_at},{headers}):new Response(null,{status:204,headers});
  if (manifest) {
    let github:any=null;try{const remote=await fetch('https://github.com/Dexi-lov/migajas-launcher/releases/latest/download/latest.json',{signal:AbortSignal.timeout(5000),cf:{cacheTtl:60,cacheEverything:true}});if(remote.ok){const candidate:any=await remote.json();if(stableVersion.test(candidate.version))github=candidate;}}catch{}
    if(github&&(!active||compare(github.version,active.version)>0)&&compare(github.version,manifest[1])>0)return Response.json(github,{headers});
    if (!active || compare(active.version, manifest[1]) <= 0) return new Response(null,{status:204,headers});
    return Response.json({ version: active.version, notes: active.notes, pub_date: active.published_at, platforms: { 'windows-x86_64': { signature: active.signature, url: url.origin + '/updates/' + active.id + '/download' } } }, { headers });
  }
  if (!active || active.id !== download![1]) return new Response('Actualización no disponible.', { status: 404, headers });
  const { data, error } = await bucket(env).createSignedUrl(active.storage_path, 600);
  if (error || !data) return new Response('No se pudo preparar la descarga.', { status: 503, headers });
  return new Response(null,{status:302,headers:{...headers,location:data.signedUrl}});
}
