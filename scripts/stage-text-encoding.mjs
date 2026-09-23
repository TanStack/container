import {createHash} from 'node:crypto'

export function stageTextEncoding(source,kind){
  const hashes={TextEncoder:'db943276d3c677eff11a0cd643710f556f70bdbad9d919da8f2be7cd62d418ce',TextDecoder:'e502f359dc14ad04c0bab1b664ebb3b2b0b793cc92129988782438aecb651a56'}
  if(createHash('sha256').update(source).digest('hex')!==hashes[kind])throw Error('Text encoding source changed: '+kind)
  const marker=kind==='TextEncoder'?'    encode(input = "") {':'        // Initialize decoder if not already done'
  if(source.split(marker).length!==2)throw Error('Text encoding patch boundary changed')
  const fast=kind==='TextEncoder'?`
        if (typeof input === "string" && this.enc.getName() === "utf-8" && typeof globalThis.__webContainerHost?.encodeUTF8 === "function") {
            return new Uint8Array(globalThis.__webContainerHost.encodeUTF8(input));
        }
        if (typeof input === "string" && this.enc.getName() === "utf-8" && /^[\\x00-\\x7f]*$/.test(input)) {
            const bytes = new Uint8Array(input.length);
            for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i);
            return bytes;
        }
`:`        // Only a fresh, final UTF-8 decode can bypass the streaming state.
        if (!stream && this.decoder == null && this.enc.getName() === "utf-8") {
            let ascii = true;
            for (let i = 0; i < bytes.length; i++) {
                if (bytes[i] >= 128) { ascii = false; break; }
            }
            if (ascii) {
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 4096) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 4096)));
                this.seenBOM = !this.ignoreBOM && bytes.length > 0;
                return chunks.join("");
            }
        }
`
  return source.replace(marker,kind==='TextEncoder'?marker+fast:fast+marker)
}
