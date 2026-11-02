const fs=require('node:fs');
let key=(process.env.TAURI_SIGNING_PRIVATE_KEY||'').trim().replace(/^\uFEFF/,'');
if(!key)throw Error('Falta TAURI_SIGNING_PRIVATE_KEY.');
for(let attempt=0;attempt<4;attempt++){
 key=key.replace(/^(["'])([\s\S]*)\1$/,'$2').replace(/\\r\\n|\\n/g,'\n').trim();
 if(/^untrusted comment:/i.test(key))break;
 if(!/^[A-Za-z0-9+/=\s]+$/.test(key))break;
 const packet=Buffer.from(key.replace(/\s/g,''),'base64');
 if(packet.length===158&&packet.subarray(0,2).toString()==='Ed'){key='untrusted comment: minisign encrypted secret key\n'+packet.toString('base64');break;}
 const decoded=packet.toString('utf8');if(!decoded||decoded===key)break;key=decoded;
}
if(!/^untrusted comment:.*(?:secret|private) key/i.test(key)){
 const kind=/^[A-Za-z]:[\\/]|^\/|^~[\\/]/.test(key)?'El secreto contiene una ruta de archivo, no el contenido de la clave.':/^untrusted comment:.*public key/i.test(key)?'El secreto contiene una clave pública, no la privada.':'El secreto no contiene una clave privada Minisign reconocible.';
 throw Error(kind+' No se ha mostrado su contenido ni cambiado la clave pública.');
}
const canonical=Buffer.from(key).toString('base64');
console.log('::add-mask::'+canonical);
fs.appendFileSync(process.env.GITHUB_ENV,'TAURI_SIGNING_PRIVATE_KEY='+canonical+'\n');
console.log('Formato de la clave privada preparado sin revelar su contenido.');
