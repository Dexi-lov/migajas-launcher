const decode64 = (value: string) => Uint8Array.from(atob(value.trim()), c => c.charCodeAt(0));
const text = (value: Uint8Array) => new TextDecoder().decode(value);
const equal = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index]);
export function signatureEnvelope(signatureInput: string, publicKeyInput: string) {
  const publicText = text(decode64(publicKeyInput));
  const publicLines = publicText.trim().split(/\r?\n/);
  const key = decode64(publicLines[1] || '');
  const signatureText = signatureInput.trim().startsWith('untrusted comment:') ? signatureInput.trim() : text(decode64(signatureInput));
  const lines = signatureText.trim().split(/\r?\n/);
  if (key.length !== 42 || key[0] !== 0x45 || key[1] !== 0x64 || lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment: ')) throw new Error('La firma no tiene el formato esperado. Usa el archivo .sig que acompaña al instalador.');
  const packet = decode64(lines[1]), globalSignature = decode64(lines[3]);
  if (packet.length !== 74 || globalSignature.length !== 64 || packet[0] !== 0x45 || ![0x44, 0x64].includes(packet[1])) throw new Error('La firma de la actualización no es válida.');
  if (!equal(key.slice(2, 10), packet.slice(2, 10))) throw new Error('Esta actualización está firmada con una clave distinta a la del launcher.');
  return {key,packet,globalSignature,lines,signatureText,canonical:btoa(String.fromCharCode(...new TextEncoder().encode(signatureText)))};
}
export function verifyUpdateSignature(
  bytes: Uint8Array, signatureInput: string, publicKeyInput: string,
  hash: (input: Uint8Array) => Uint8Array,
  verify: (signature: Uint8Array, message: Uint8Array, key: Uint8Array) => boolean,
  version: string,
): string {
  const {key,packet,globalSignature,lines,canonical}=signatureEnvelope(signatureInput,publicKeyInput);
  const publicKey = key.slice(10), signature = packet.slice(10), comment = new TextEncoder().encode(lines[2].slice(17));
  const globalMessage = new Uint8Array(64 + comment.length); globalMessage.set(signature); globalMessage.set(comment, 64);
  if (!verify(signature, packet[1] === 0x44 ? hash(bytes) : bytes, publicKey) || !verify(globalSignature, globalMessage, publicKey)) throw new Error('La firma no corresponde al instalador. La actualización anterior sigue publicada.');
  const signedComment=lines[2].slice(17);
  const signedVersion = signedComment.match(/(?:^|\s)version:([^\s]+)/)?.[1]
    || signedComment.match(/(?:^|\s)file:[^\r\n]*?(\d+\.\d+\.\d+)/)?.[1];
  if (signedVersion && signedVersion !== version) throw new Error('La versión indicada no coincide con la versión firmada.');
  return canonical;
}
