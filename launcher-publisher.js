(() => {
 'use strict';
 let request, busy=false;
 const $=selector=>document.querySelector(selector);
 function status(message){$('#launcher-publish-status').textContent=message;}
 async function refresh(){const result=await request('admin_update_status');$('#launcher-published-version').textContent=result.active?'Versión publicada: '+result.active.version:'Todavía no hay una actualización publicada desde este panel.';if(result.cleanupPending)status('La versión nueva está activa. Se reintentará limpiar la anterior automáticamente.');}
 function attach(container,api){
  if($('#community-update-tools'))return;request=api;
  const section=document.createElement('section');section.id='community-update-tools';section.hidden=true;
  section.innerHTML=`<h3>Actualizaciones del launcher</h3><p class="settings-hint">Solo ElDexs y Programador pueden publicar aquí. Selecciona el instalador y su archivo .sig de una compilación firmada. La versión anterior se elimina después de verificar y publicar la nueva.</p><p id="launcher-published-version" class="settings-hint"></p><form id="launcher-publish-form"><label>Versión nueva<input id="launcher-publish-version" required pattern="[0-9]+\\.[0-9]+\\.[0-9]+" placeholder="1.2.15"></label><label>Instalador de Windows (.exe, hasta 50 MiB)<input id="launcher-publish-file" type="file" accept=".exe" required></label><label>Firma de la compilación (.sig)<input id="launcher-publish-signature" type="file" accept=".sig" required></label><label>¿Qué cambió? Escríbelo para los jugadores, con palabras sencillas<textarea id="launcher-publish-notes" maxlength="6000" required placeholder="Ahora es más fácil organizar los eventos y hemos arreglado problemas al entrar a jugar."></textarea></label><progress id="launcher-publish-progress" value="0" max="100" hidden></progress><p id="launcher-publish-status" class="community-update-status" role="status"></p><button class="btn-primary-red" type="submit">Subir y publicar actualización</button></form>`;
  container.append(section);
  $('#launcher-publish-file').addEventListener('change',()=>{const match=$('#launcher-publish-file').files[0]?.name.match(/(\d+\.\d+\.\d+)/);if(match)$('#launcher-publish-version').value=match[1];});
  $('#launcher-publish-form').addEventListener('submit',async event=>{
   event.preventDefault();if(busy)return;
   const file=$('#launcher-publish-file').files[0],sigFile=$('#launcher-publish-signature').files[0],version=$('#launcher-publish-version').value.trim(),notes=$('#launcher-publish-notes').value.trim();
   if(!file||!sigFile||!file.name.toLowerCase().endsWith('.exe')||!sigFile.name.toLowerCase().endsWith('.sig')||file.size<1024||file.size>52428800||sigFile.size>16384){status('Selecciona el instalador EXE y su firma .sig.');return;}
   if(!confirm(`¿Publicar la versión ${version} para todos los jugadores? Al validar la nueva actualización se borrará la anterior de este almacenamiento.`))return;
   busy=true;const controls=[...event.target.querySelectorAll('input,textarea,button')];controls.forEach(c=>c.disabled=true);let uploadId=null;
   const progress=$('#launcher-publish-progress');progress.hidden=false;progress.value=5;
   try{
    status('Comprobando los archivos…');const bytes=new Uint8Array(await file.arrayBuffer());if(bytes[0]!==77||bytes[1]!==90)throw new Error('El archivo no es un instalador de Windows.');
    const signature=await sigFile.text();let decodedSignature=signature;try{decodedSignature=atob(signature.trim());}catch{}if(/secret key/i.test(decodedSignature))throw new Error('Selecciona únicamente el archivo de firma .sig.');
    const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const upload=await request('admin_update_begin',{version,notes,signature,size:file.size,sha256});uploadId=upload.uploadId;progress.value=20;status('Subiendo la actualización…');
    const config=window.MIGAJAS_SOCIAL_CONFIG;const client=window.MigajasSupabase.createClient(config.url,config.publishableKey,{auth:{persistSession:false,autoRefreshToken:false}});
    const {error}=await client.storage.from('migajas-launcher-updates').uploadToSignedUrl(upload.path,upload.token,bytes,{contentType:'application/octet-stream'});if(error)throw new Error('La subida se interrumpió. La actualización anterior sigue disponible.');
    progress.value=70;status('Verificando la firma y preparando la publicación…');
    const result=await request('admin_update_complete',{uploadId});uploadId=null;progress.value=100;await refresh();
    status(result.cleanupPending?'Actualización publicada. La limpieza de la anterior se reintentará automáticamente.':'Actualización publicada. La anterior ya se eliminó del almacenamiento.');event.target.reset();
   }catch(error){status(error.message||String(error));if(uploadId)try{await request('admin_update_cancel',{uploadId});}catch{}}
   finally{busy=false;controls.forEach(c=>c.disabled=false);}
  });
 }
 window.MigajasPublisher={attach,refresh};
})();
