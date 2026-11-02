const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async request=>{
 if(request.method!=='POST')return reply({error:'Método no permitido.'},405);
 const secret=Deno.env.get('MIGAJAS_VERIFIER_SECRET');
 if(!secret)return reply({error:'Verificador no configurado.'},503);
 const expected=secret;
 const actual=request.headers.get('x-migajas-verifier-secret')||'';
 let difference=actual.length^expected.length;for(let i=0;i<Math.max(actual.length,expected.length);i++)difference|=(actual.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);
 if(difference!==0)return reply({error:'Verificación no autorizada.'},403);
 try{
  const raw=await request.text();if(raw.length>10000)return reply({error:'Petición demasiado grande.'},413);
  const token=String(JSON.parse(raw).minecraftAccessToken||'');if(!token||token.length>8192)return reply({error:'Sesión inválida.'},401);
  const result=await fetch('https://api.minecraftservices.com/minecraft/profile',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(6000)});
  if(result.status===401)return reply({error:'La sesión de Minecraft caducó.'},401);
  if(!result.ok)return reply({error:'Minecraft no está disponible para verificar la sesión.',upstreamStatus:result.status},503);
  const data=await result.json();const uuid=String(data.id||'').replaceAll('-','').toLowerCase();const username=String(data.name||'');
  if(!/^[a-f0-9]{32}$/.test(uuid)||!/^[A-Za-z0-9_]{1,16}$/.test(username))return reply({error:'Minecraft devolvió un perfil inválido.'},502);
  return reply({uuid,username});
 }catch{return reply({error:'No se pudo verificar Minecraft en este momento.'},503);}
});
