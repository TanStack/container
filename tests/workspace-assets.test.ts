import {describe,it,expect} from 'vitest'
import {WorkspaceFiles} from '../src/sandbox/files'
import {createWorkspaceAssetReader} from '../src/sandbox/workspace-assets'

describe('workspace asset authority',()=>{
  it('reads binary files, handles URL encoding and HEAD, and does not alias workspace bytes',()=>{
    const files=new WorkspaceFiles({'/a b.wasm':new Uint8Array([0,255,42])}),read=createWorkspaceAssetReader(files)
    const result=read('https://workspace.invalid/a%20b.wasm?v=1#fragment','GET')
    expect(result.metadata).toEqual({url:'https://workspace.invalid/a%20b.wasm?v=1',status:200,statusText:'OK',headers:{'content-type':'application/wasm','content-length':'3'}})
    result.bytes![0]=100
    expect(read('file:///a%20b.wasm','GET').bytes).toEqual(new Uint8Array([0,255,42]))
    expect(read('file:///a%20b.wasm','HEAD').bytes).toBe(null)
    expect(read('file:///missing','GET').metadata.status).toBe(404)
    expect(read('file:///','GET').metadata.status).toBe(404)
    expect(read('file:///file.constructor','HEAD').metadata.headers['content-type']).toBe('application/octet-stream')
    expect(read('file:///file.__proto__','HEAD').metadata.headers['content-type']).toBe('application/octet-stream')
  })
  it('denies network, other origins, credentials, malformed paths and unsupported methods',()=>{
    const read=createWorkspaceAssetReader(new WorkspaceFiles())
    for(const url of ['https://example.com/x','http://workspace.invalid/x','https://workspace.invalid:444/x','https://workspace.invalid.example/x','https://user:pass@workspace.invalid/x','file://server/x','data:,hello','blob:https://workspace.invalid/id','/relative','file:///%00','file:///%5csecret','file:///%2e%2e%2fsecret','file:///%zz'])
      expect(()=>read(url,'GET'),url).toThrow()
    expect(()=>read('file:///a','POST')).toThrow('GET and HEAD')
  })
  it('resolves virtual symlinks without reading the machine filesystem',()=>{
    const files=new WorkspaceFiles({'/secret':'virtual'})
    files.symlinkSync('/secret','/alias')
    files.symlinkSync('/etc/passwd','/host')
    const read=createWorkspaceAssetReader(files)
    expect(new TextDecoder().decode(read('file:///alias','GET').bytes!)).toBe('virtual')
    expect(read('file:///host','GET').metadata.status).toBe(404)
  })
  it('bounds per-file bytes, cumulative bytes, request count, and resets per execution',()=>{
    const files=new WorkspaceFiles({'/big':new Uint8Array(8*1024*1024+1),'/chunk':new Uint8Array(8*1024*1024)})
    const read=createWorkspaceAssetReader(files)
    expect(()=>read('file:///big','GET')).toThrow('byte quota')
    expect(read('file:///big','HEAD').bytes).toBe(null)
    for(let i=0;i<4;i++)expect(read('file:///chunk','GET').bytes!.length).toBe(8*1024*1024)
    expect(()=>read('file:///chunk','GET')).toThrow('byte quota')
    const second=createWorkspaceAssetReader(files)
    expect(second('file:///chunk','GET').metadata.status).toBe(200)
    for(let i=1;i<128;i++)second('file:///missing','HEAD')
    expect(()=>second('file:///missing','HEAD')).toThrow('request quota')
  })
})
