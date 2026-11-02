(function(root){
 'use strict';
 function authenticatorUri(totp,account){
  if(!totp||typeof totp!=='object')throw new Error('No se recibieron los datos del autenticador. Vuelve a iniciar sesión administrativa.');
  let source=typeof totp.uri==='string'?totp.uri.trim():'';
  if(!source&&typeof totp.secret==='string'){
   const label='Migajas Studio:'+String(account||'Administración');
   source='otpauth://totp/'+encodeURIComponent(label)+'?'+new URLSearchParams({secret:totp.secret,issuer:'Migajas Studio',algorithm:'SHA1',digits:'6',period:'30'});
  }
  let uri;try{uri=new URL(source);}catch{throw new Error('No se recibieron datos TOTP válidos. Vuelve a intentarlo.');}
  const secret=uri.searchParams.get('secret')||'';
  if(uri.protocol!=='otpauth:'||uri.hostname!=='totp'||uri.pathname.length<2||secret.length<8||secret.length>256||!/^[A-Z2-7]+=*$/i.test(secret))throw new Error('La configuración del autenticador no es válida.');
  return uri.href;
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={authenticatorUri};else root.MigajasMfaQr={authenticatorUri};
})(typeof window!=='undefined'?window:globalThis);
