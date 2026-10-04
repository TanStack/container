export async function fingerprintFiles(files:Record<string,Uint8Array>){
  const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')
  const rows=[]
  for(const path of Object.keys(files).sort()){
    const bytes=Uint8Array.from(files[path])
    rows.push([path,bytes.length,hex(await crypto.subtle.digest('SHA-256',bytes))])
  }
  return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(rows))))
}
