export function stageFetchResponse(source){
  const marker='\tstatic redirect(url, status = 302) {'
  if(source.split(marker).length!==2)throw Error('Unexpected Response source')
  return source.replace(marker,`\tstatic json(data, init = {}) {
    if (arguments.length === 0) throw new TypeError('JSON data is required');
    const serialized = JSON.stringify(data);
    if (serialized === undefined) throw new TypeError('Data is not JSON serializable');
    if (init === null || (typeof init !== 'object' && typeof init !== 'function')) throw new TypeError('Invalid ResponseInit');
    const options = init ?? {};
    const headers = new Headers(options.headers);
    const number = options.status === undefined ? 200 : Number(options.status);
    const status = Number.isFinite(number) ? ((Math.trunc(number) % 65536) + 65536) % 65536 : 0;
    if (status < 200 || status > 599) throw new RangeError('Invalid response status');
    if ([204, 205, 304].includes(status)) throw new TypeError('Response status cannot have a body');
    const statusText = options.statusText === undefined ? '' : String(options.statusText);
    if (/[^\\t\\x20-\\x7e\\x80-\\xff]/.test(statusText)) throw new TypeError('Invalid status text');
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(new TextEncoder().encode(serialized), {status, statusText, headers});
  }

`+marker)
}
