// Both filesystem entry points use the same guest-owned constructors, without
// making either entry point depend on the other during initialization.
const fsTypes = globalThis.__webContainerHost.fsTypes ??= (() => {
  class FileType {
    isFile() { return this.kind === 'file' }
    isDirectory() { return this.kind === 'directory' }
    isSymbolicLink() { return this.kind === 'symlink' }
    isBlockDevice() { return false }
    isCharacterDevice() { return false }
    isFIFO() { return false }
    isSocket() { return false }
  }
  class Dirent extends FileType {
    constructor(value, encoding) {
      super()
      this.name = encoding === 'buffer' ? Buffer.from(value.name) : value.name
      this.parentPath = value.parentPath
      this.path = value.parentPath
      this.kind = value.kind
    }
  }
  class Stats extends FileType {
    constructor(value){
      super();Object.assign(this,value)
      for(const name of ['atime','mtime','ctime','birthtime'])this[name]=new Date(value[name+'Ms'])
    }
  }
  class BigIntStats extends FileType {
    constructor(value){
      super()
      for(const [name,field] of Object.entries(value))this[name]=typeof field==='number'?BigInt(Math.trunc(field)):field
      for(const name of ['atime','mtime','ctime','birthtime']){
        // Workspace timestamps have millisecond precision. Do not invent
        // sub-millisecond precision when exposing Node's nanosecond fields.
        this[name+'Ns']=BigInt(Math.trunc(value[name+'Ms']))*1000000n
        this[name]=new Date(value[name+'Ms'])
      }
    }
  }
  const stats=(value,options)=>options?.bigint?new BigIntStats(value):new Stats(value)
  return {Dirent,Stats,BigIntStats,stats}
})()
