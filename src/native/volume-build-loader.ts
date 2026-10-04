import type {Plugin} from 'vite'
import {existsSync,statSync,readFileSync} from '../vite-browser/node-fs'

export function volumeBuildLoader():Plugin{
  return {
    name:'browser-native-volume-build-loader',enforce:'pre',
    load(id){
      if(id.includes('?url'))return
      const path=id.split('?')[0]
      if(!/^\/app\/.+\.(?:[cm]?[jt]sx?|json|css|html|astro|svelte|vue)$/.test(path)||!existsSync(path)||!statSync(path).isFile())return
      return readFileSync(path,'utf8') as string
    },
  }
}
