// WASI preview1 layouts: prestat 8, fdstat 24, filestat 64, dirent 24 bytes.
// ABI constants checked against @tybys/wasm-util's preview1/types reference.
const errno={EACCES:2,EBADF:8,EBUSY:10,EEXIST:20,EFAULT:21,EINVAL:28,EIO:29,EISDIR:31,ELOOP:32,EMFILE:33,ENAMETOOLONG:37,ENOENT:44,ENOSPC:51,ENOSYS:52,ENOTDIR:54,ENOTEMPTY:55,ENOTSUP:58,EOVERFLOW:61,EPERM:63,EROFS:69,ENOTCAPABLE:76}
const bit=n=>1n<<BigInt(n)
const fail=code=>{throw Object.assign(new Error(code),{code})}
const fileRights=[1,2,5,6,21,27].reduce((a,n)=>a|bit(n),0n)
const dirRights=[9,10,13,14,15,18,19,21,25,26].reduce((a,n)=>a|bit(n),0n)
const type=s=>s.isDirectory()?3:s.isFile()?4:s.isSymbolicLink()?7:s.isCharacterDevice?.()?2:s.isBlockDevice?.()?1:0
const within=(root,path)=>path===root||path.startsWith(root==='/'?'/':root+'/')
const parent=path=>path.slice(0,path.lastIndexOf('/'))||'/'

export function createWASIFileSystem(fs,preopens,getMemory){
  const descriptors=new Map();let next=3
  const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true})
  const memory=()=>new Uint8Array(getMemory().buffer)
  const range=(p,n)=>{const bytes=memory();if(!Number.isInteger(p)||!Number.isInteger(n)||p<0||n<0||p>bytes.length||n>bytes.length-p)fail('EFAULT');return bytes.subarray(p,p+n)}
  const view=(p,n)=>{const b=range(p,n);return new DataView(b.buffer,b.byteOffset,b.byteLength)}
  const get=(fd,right=0n)=>{const d=descriptors.get(fd);if(!d)fail('EBADF');if((d.base&right)!==right)fail('ENOTCAPABLE');return d}
  const stat=d=>d.handle===undefined?fs.statSync(d.path):fs.fstatSync(d.handle)
  for(const [name,path] of Object.entries(preopens??{})){
    const root=fs.realpathSync(path);if(!fs.statSync(root).isDirectory())fail('ENOTDIR')
    descriptors.set(next++,{path:root,root,name,base:dirRights,inheriting:dirRights|fileRights,flags:0,position:0})
  }
  const pathAt=(fd,p,n,right,follow=true,create=false)=>{
    const d=get(fd,right);if(!stat(d).isDirectory())fail('ENOTDIR')
    let name;try{name=dec.decode(range(p,n))}catch(error){if(error.code)throw error;fail('EINVAL')}
    if(!name)fail('ENOENT');if(name.includes('\0'))fail('EINVAL');if(name.startsWith('/'))fail('ENOTCAPABLE')
    const parts=d.path.split('/').filter(Boolean)
    for(const part of name.split('/')){if(part==='..'){parts.pop();if(!within(d.root,'/'+parts.join('/')))fail('ENOTCAPABLE')}else if(part&&part!=='.')parts.push(part)}
    const target='/'+parts.join('/');if(!within(d.root,target))fail('ENOTCAPABLE')
    // Resolve parents even for no-follow operations, keeping all operations in this preopen.
    const realParent=fs.realpathSync(parent(target));if(!within(d.root,realParent)&&target!==d.root)fail('ENOTCAPABLE')
    let actual=target
    if(follow){try{actual=fs.realpathSync(target)}catch(error){if(!create||error.code!=='ENOENT')throw error;actual=(realParent==='/'?'':realParent)+'/'+target.slice(target.lastIndexOf('/')+1)}}
    else actual=target===d.root?target:(realParent==='/'?'':realParent)+'/'+target.slice(target.lastIndexOf('/')+1)
    if(!within(d.root,actual))fail('ENOTCAPABLE');return {d,path:actual}
  }
  const putStat=(s,p)=>{const v=view(p,64);range(p,64).fill(0);v.setBigUint64(0,BigInt(s.dev??0),true);v.setBigUint64(8,BigInt(s.ino??0),true);v.setUint8(16,type(s));v.setBigUint64(24,BigInt(s.nlink??1),true);v.setBigUint64(32,BigInt(s.size??0),true);for(const [offset,key] of [[40,'atime'],[48,'mtime'],[56,'ctime']])v.setBigUint64(offset,s[key+'Ns']??BigInt(Math.max(0,Math.trunc(Number(s[key+'Ms']??0)*1e6))),true)}
  const io=(fd,iovs,count,result,write)=>{
    const d=get(fd,bit(write?6:1));if(stat(d).isDirectory())fail('EISDIR');const out=view(result,4),vectors=view(iovs,count*8);let total=0
    for(let i=0;i<count;i++){const bytes=range(vectors.getUint32(i*8,true),vectors.getUint32(i*8+4,true));const position=write&&(d.flags&1)?Number(stat(d).size):d.position;const n=write?fs.writeSync(d.handle,bytes,0,bytes.length,position):fs.readSync(d.handle,bytes,0,bytes.length,position);d.position=position+n;total+=n;if(n<bytes.length)break}
    out.setUint32(0,total,true)
  }
  const implementations={
    fd_prestat_get(fd,p){const d=get(fd);if(d.name===undefined)fail('EBADF');const v=view(p,8);range(p,8).fill(0);v.setUint32(4,enc.encode(d.name).length,true)},
    fd_prestat_dir_name(fd,p,n){const d=get(fd);if(d.name===undefined)fail('EBADF');const name=enc.encode(d.name);if(n<name.length)fail('ENAMETOOLONG');range(p,name.length).set(name)},
    fd_close(fd){const d=get(fd);if(d.handle!==undefined)fs.closeSync(d.handle);descriptors.delete(fd)},
    fd_fdstat_get(fd,p){const d=get(fd),v=view(p,24);range(p,24).fill(0);v.setUint8(0,type(stat(d)));v.setUint16(2,d.flags,true);v.setBigUint64(8,d.base,true);v.setBigUint64(16,d.inheriting,true)},
    fd_filestat_get(fd,p){putStat(stat(get(fd,bit(21))),p)},
    fd_read(fd,iovs,count,p){io(fd,iovs,count,p,false)},
    fd_write(fd,iovs,count,p){io(fd,iovs,count,p,true)},
    fd_seek(fd,offset,whence,p){const d=get(fd,bit(2)),v=view(p,8);const start=whence===0?0:whence===1?d.position:whence===2?Number(stat(d).size):fail('EINVAL');const result=BigInt(start)+BigInt(offset);if(result<0n)fail('EINVAL');if(result>BigInt(Number.MAX_SAFE_INTEGER))fail('EOVERFLOW');d.position=Number(result);v.setBigUint64(0,result,true)},
    fd_tell(fd,p){view(p,8).setBigUint64(0,BigInt(get(fd,bit(5)).position),true)},
    fd_readdir(fd,p,n,cookie,used){const d=get(fd,bit(14));if(!stat(d).isDirectory())fail('ENOTDIR');const output=range(p,n),v=view(used,4);if(BigInt(cookie)<0n||BigInt(cookie)>BigInt(Number.MAX_SAFE_INTEGER))fail('EINVAL');const names=fs.readdirSync(d.path);let count=0;for(let i=Number(cookie);i<names.length&&count<n;i++){const name=enc.encode(names[i]),s=fs.lstatSync(d.path+'/'+names[i]),entry=new Uint8Array(24+name.length),e=new DataView(entry.buffer);e.setBigUint64(0,BigInt(i+1),true);e.setBigUint64(8,BigInt(s.ino??0),true);e.setUint32(16,name.length,true);e.setUint8(20,type(s));entry.set(name,24);const take=Math.min(entry.length,n-count);output.set(entry.subarray(0,take),count);count+=take}v.setUint32(0,count,true)},
    path_open(fd,lookup,p,n,oflags,base,inheriting,flags,result){
      const out=view(result,4);if(lookup&~1||oflags&~15)fail('EINVAL');if(flags&~5)fail('ENOTSUP');base=BigInt(base);inheriting=BigInt(inheriting)
      const {d,path}=pathAt(fd,p,n,bit(13)|(oflags&1?bit(10):0n)|(oflags&8?bit(19):0n),!!(lookup&1),!!(oflags&1))
      if((base&d.inheriting)!==base||(inheriting&d.inheriting)!==inheriting)fail('ENOTCAPABLE')
      let s;try{s=fs.lstatSync(path)}catch(error){if(error.code!=='ENOENT'||!(oflags&1))throw error}
      if(s?.isSymbolicLink())fail('ELOOP');if(oflags&2&&!s?.isDirectory())fail(s?'ENOTDIR':'ENOENT');if(s&&oflags&1&&oflags&4)fail('EEXIST')
      const directory=s?.isDirectory();if(directory&&(oflags&8||base&bit(6)))fail('EISDIR')
      if(directory){if(flags&4||(base&~dirRights)!==0n)fail('ENOTSUP')}
      else{
        // The parent capability check above applies to every requested right.
        // libc may request both file and directory rights before knowing the
        // target type. Regular files grant only file rights and inherit none.
        base&=fileRights;inheriting=0n
        // Virtual regular-file reads are immediately available. NONBLOCK is
        // retained in fdstat; it does not imply support for pipes or devices.
      }
      const c=fs.constants;const write=!!(base&bit(6)),read=!!(base&bit(1));let handle
      if(!directory){if(oflags&8&&!write)fail('ENOTCAPABLE');let mode=write?(read?c.O_RDWR:c.O_WRONLY):c.O_RDONLY;if(oflags&1)mode|=c.O_CREAT;if(oflags&4)mode|=c.O_EXCL;if(oflags&8)mode|=c.O_TRUNC;handle=fs.openSync(path,mode,0o666)}
      const number=next++;descriptors.set(number,{path,root:d.root,handle,base,inheriting,flags,position:0});out.setUint32(0,number,true)
    },
    path_filestat_get(fd,lookup,p,n,result){if(lookup&~1)fail('EINVAL');const {path}=pathAt(fd,p,n,bit(18),!!(lookup&1));putStat(lookup&1?fs.statSync(path):fs.lstatSync(path),result)},
    path_create_directory(fd,p,n){fs.mkdirSync(pathAt(fd,p,n,bit(9),false,true).path)},
    path_readlink(fd,p,n,out,size,used){const target=range(out,size),v=view(used,4);const value=enc.encode(fs.readlinkSync(pathAt(fd,p,n,bit(15),false).path));const count=Math.min(size,value.length);target.set(value.subarray(0,count));v.setUint32(0,count,true)},
    path_remove_directory(fd,p,n){fs.rmdirSync(pathAt(fd,p,n,bit(25),false).path)},
    path_unlink_file(fd,p,n){fs.unlinkSync(pathAt(fd,p,n,bit(26),false).path)},
  }
  const imports=Object.fromEntries(Object.entries(implementations).map(([name,fn])=>[name,(...args)=>{try{fn(...args);return 0}catch(error){return errno[error?.code]??(error instanceof RangeError?21:29)}}]))
  const poll=(fd,eventType)=>{
    try{
      const d=get(fd),s=stat(d)
      if(eventType!==1&&eventType!==2)fail('EINVAL')
      if(!s.isFile())fail('ENOTSUP')
      get(fd,bit(27)|bit(eventType===1?1:6))
      const remaining=BigInt(s.size)-BigInt(d.position)
      return {error:0,nbytes:eventType===1&&remaining>0n?remaining:0n,flags:0}
    }catch(error){return {error:errno[error?.code]??(error instanceof RangeError?21:29)}}
  }
  return {imports,poll,close(){for(const [fd,d] of descriptors){if(d.handle!==undefined)fs.closeSync(d.handle);descriptors.delete(fd)}}}
}
