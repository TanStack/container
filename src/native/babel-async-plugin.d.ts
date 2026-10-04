declare module '@babel/plugin-transform-async-to-generator' {
  import type {PluginObj} from '@babel/core'

  const imported:(api:unknown,options:Record<string,never>)=>PluginObj
  export default imported
}
