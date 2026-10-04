import {describe,expect,it} from 'vitest'
import {Volume} from 'memfs'
import {VolumeFileSystem} from '../src/native/volume-file-system'
import {writeFileWithParents} from '../src/native/write-file-with-parents.mjs'

describe('native volume filesystem',()=>{
  it('keeps binary files and lists only files below a prefix',async()=>{
    const volume=Volume.fromJSON({'/app/first.txt':'first'})
    const fs=new VolumeFileSystem(volume)
    await fs.writeFile('/app/nested/binary.bin',new Uint8Array([0,127,255]))
    expect(await fs.list('/app')).toEqual(['/app/first.txt','/app/nested/binary.bin'])
    expect([...await fs.readFile('/app/nested/binary.bin')]).toEqual([0,127,255])
    expect(await fs.isFile('/app/nested')).toBe(false)
  })

  it('uses one checked owner write while local volumes keep the same file behavior',async()=>{
    for(const remote of [false,true]){
      const volume=Volume.fromJSON({}),calls:string[]=[]
      const original={lstatSync:volume.lstatSync,mkdirSync:volume.mkdirSync,writeFileSync:volume.writeFileSync}
      const owner=remote?Object.assign(Object.create(volume),{
        writeFileWithParentsSync(path:string,contents:Uint8Array,options:{followSymlinks?:boolean;mode?:number}){
          calls.push(path);writeFileWithParents(volume,path,contents,options)
        },
        lstatSync(){throw Error('Client must not check path segments')},
        mkdirSync(){throw Error('Client must not create parents separately')},
        writeFileSync(){throw Error('Client must not write separately')},
      }):volume
      const fs=new VolumeFileSystem(owner)
      await fs.writeFile('/app/nested/../bin/program',new Uint8Array([0,127,255]),{followSymlinks:false,mode:0o755})
      expect([...volume.readFileSync('/app/bin/program')]).toEqual([0,127,255])
      expect(volume.statSync('/app/bin/program').mode&0o777).toBe(0o755)
      await fs.writeFile('/app/bin/program',new Uint8Array([1]),{followSymlinks:false,mode:0o644})
      expect([...volume.readFileSync('/app/bin/program')]).toEqual([1])
      expect(volume.statSync('/app/bin/program').mode&0o777).toBe(0o755)
      await expect(fs.writeFile('/',new Uint8Array())).rejects.toThrow('workspace root')
      if(remote)expect(calls).toEqual(['/app/bin/program','/app/bin/program','/'])
      expect(volume.lstatSync).toBe(original.lstatSync)
      expect(volume.mkdirSync).toBe(original.mkdirSync)
      expect(volume.writeFileSync).toBe(original.writeFileSync)
    }
  })

  it('rejects writes through both live and dangling symlinks',async()=>{
    const volume=Volume.fromJSON({'/app/target/file.txt':'old'})
    volume.symlinkSync('/app/target','/app/live')
    volume.symlinkSync('/app/missing','/app/dangling')
    const fs=new VolumeFileSystem(volume)
    for(const path of ['/app/live/file.txt','/app/dangling/file.txt']){
      await expect(fs.writeFile(path,new Uint8Array([1]),{followSymlinks:false})).rejects.toThrow('symbolic link')
    }
    expect(volume.readFileSync('/app/target/file.txt','utf8')).toBe('old')
  })

  it('does not treat synthesized proxy methods as declared checked-write support',async()=>{
    const volume=Volume.fromJSON({}),calls:string[]=[]
    const operations=new Proxy(volume,{get(target,key){
      const value=Reflect.get(target,key)
      if(typeof value==='function')return (...args:unknown[])=>{
        calls.push(String(key));return Reflect.apply(value,target,args)
      }
      if(value===undefined)return ()=>{throw Error('Undeclared remote operation: '+String(key))}
      return value
    }})
    const fs=new VolumeFileSystem(operations)
    await fs.writeFile('/app/nested/file.bin',new Uint8Array([0,127,255]),{followSymlinks:false,mode:0o755})
    expect([...volume.readFileSync('/app/nested/file.bin')]).toEqual([0,127,255])
    expect(volume.statSync('/app/nested/file.bin').mode&0o777).toBe(0o755)
    expect(calls).toEqual(['lstatSync','lstatSync','lstatSync','mkdirSync','writeFileSync'])
    volume.symlinkSync('/app/nested','/app/link')
    await expect(fs.writeFile('/app/link/file.bin',new Uint8Array([1]),{followSymlinks:false})).rejects.toThrow('symbolic link')
    expect([...volume.readFileSync('/app/nested/file.bin')]).toEqual([0,127,255])
  })

  it('lists through public operations without reading contents or walking unrelated trees',async()=>{
    const volume=Volume.fromJSON({'/app/nested/file.txt':'app','/other/private.txt':'other'})
    const calls:string[]=[]
    const operations=new Proxy(volume,{get(target,key){
      if(key!=='lstatSync'&&key!=='readdirSync')throw Error('Unexpected operation: '+String(key))
      return (path:string,...args:unknown[])=>{
        calls.push(path)
        return Reflect.apply(target[key],target,[path,...args])
      }
    }})
    expect(await new VolumeFileSystem(operations).list('/app')).toEqual(['/app/nested/file.txt'])
    expect(calls.every(path=>path==='/app'||path.startsWith('/app/'))).toBe(true)
  })

  it('lists files and missing roots without following directory or file symlinks',async()=>{
    const volume=Volume.fromJSON({'/app/nested/file.txt':'value'})
    volume.symlinkSync('/app','/app/loop')
    volume.symlinkSync('/app/nested/file.txt','/app/file-link')
    volume.symlinkSync('/missing','/app/dangling')
    const fs=new VolumeFileSystem(volume)
    expect(await fs.list('/app')).toEqual(['/app/nested/file.txt'])
    expect(await fs.list('/app/nested/file.txt')).toEqual(['/app/nested/file.txt'])
    expect(await fs.list('/app/missing')).toEqual([])
    expect(await fs.list('/app/file-link')).toEqual([])
  })
})
