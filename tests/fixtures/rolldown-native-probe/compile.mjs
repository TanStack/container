export const files={'/project/main.js':"import value from './value.js';import extra from 'virtual:answer';export default value+extra",'/project/value.js':'export default 39'}
export async function compile(binding,callback,cwd='/project'){
  const bundler=new binding.BindingBundler()
  binding.startAsyncRuntime()
  try{
    const result=await bundler.generate({
      inputOptions:{input:[{import:cwd+'/main.js'}],cwd,platform:'browser',logLevel:0,onLog(){},plugins:[{name:'guest-hooks',hookUsage:26,
        resolveId:(_ctx,...args)=>callback('resolveId',args.slice(0,2)),
        load:(_ctx,id)=>callback('load',[id]),
        transform:(_ctx,code,id)=>callback('transform',[id,code]),
      }]},
      outputOptions:{format:'es',plugins:[]},
    })
    if(result.isBindingErrors)throw Error(JSON.stringify(result.errors))
    return result.chunks.map(chunk=>({code:chunk.getCode(),filename:chunk.getFileName()}))
  }finally{await bundler.close();await binding.shutdownAsyncRuntime()}
}
