const {authenticatorUri}=require('../mfa-qr');const assert=require('node:assert/strict');
const uri='otpauth://totp/MigajasTest?secret=JBSWY3DPEHPK3PXP&issuer=MigajasTest';
assert.equal(authenticatorUri({uri}),'otpauth://totp/MigajasTest?secret=JBSWY3DPEHPK3PXP&issuer=MigajasTest');
const fallback=new URL(authenticatorUri({secret:'JBSWY3DPEHPK3PXP'},'test@example.invalid'));assert.equal(fallback.searchParams.get('secret'),'JBSWY3DPEHPK3PXP');assert.equal(fallback.searchParams.get('issuer'),'Migajas Studio');
for(const invalid of [null,{}, {uri:'https://example.invalid/?secret=JBSWY3DPEHPK3PXP'}, {uri:'otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP'},{secret:'invalid!'}])assert.throws(()=>authenticatorUri(invalid));
console.log('OK: URI TOTP, alternativa con clave secreta y rechazo de formatos inválidos.');
