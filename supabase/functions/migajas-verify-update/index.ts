import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { ed25519 } from 'npm:@noble/curves@1.9.7/ed25519';
import { blake2b } from 'npm:@noble/hashes@2.4.0/blake2.js';
import { verifyUpdateSignature } from '../_shared/update-signature.ts';

Deno.serve(async request => {
  const expected = Deno.env.get('MIGAJAS_VERIFIER_SECRET');
  if(request.method!=='POST'||!expected)return Response.json({error:'Acceso no autorizado.'},{status:403});
  const supplied=request.headers.get('x-migajas-verifier-secret')||'';let difference=supplied.length^expected.length;for(let i=0;i<Math.max(supplied.length,expected.length);i++)difference|=(supplied.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);if(difference)return Response.json({error:'Acceso no autorizado.'},{status:403});
  try {
    const raw=await request.text();if(raw.length>24000)throw new Error('Petición demasiado grande.');const body=JSON.parse(raw);
    if (!/^[a-f0-9-]{36}\/MigajasLauncher-\d+\.\d+\.\d+\.exe$/.test(body.path) || !Number.isSafeInteger(body.size) || body.size < 1024 || body.size > 52428800 || typeof body.signature !== 'string' || body.signature.length > 16384 || typeof body.publicKey !== 'string' || body.publicKey.length > 2048 || !/^\d+\.\d+\.\d+$/.test(body.version)) throw new Error('Datos de actualización inválidos.');
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.storage.from('migajas-launcher-updates').download(body.path);
    if (error || !data || data.size !== body.size) throw new Error('La subida no se completó. Vuelve a subir el instalador.');
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('El archivo no es un instalador de Windows.');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (sha256 !== body.sha256) throw new Error('El instalador subido no coincide con el archivo seleccionado.');
    const signature = verifyUpdateSignature(bytes, body.signature, body.publicKey, input => blake2b(input, { dkLen: 64 }), (sig, message, key) => ed25519.verify(sig, message, key, { zip215: false }), body.version);
    return Response.json({ valid: true, sha256, signature });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'No se pudo verificar la actualización.' }, { status: 400 });
  }
});
