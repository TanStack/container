import {createElement as h,createContext,useContext,useEffect,useState} from 'react'
import {hydrateRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'

const outer=createContext('outer-default')
const inner=createContext('inner-default')
const events=[]
let subscriptions=0
const errors={recoverable:[],uncaught:[],caught:[]}
const caseName=globalThis.__hydrationCase
let root

function Consumer(){
  const outside=useContext(outer),inside=useContext(inner)
  const [count,setCount]=useState(0)
  useEffect(()=>{
    subscriptions++
    events.push({kind:'mount',outside,inside})
    return ()=>{subscriptions--;events.push({kind:'cleanup',outside,inside})}
  },[outside,inside])
  return h('button',{id:'consumer',onClick:()=>setCount(x=>x+1)},`${outside}/${inside}/${count}`)
}
function Navbar(){return h('a',{href:'#context'},'Navigation')}
function Contents(){return h(inner.Provider,{value:'inner-value'},h(Navbar),h(Consumer))}
function App({value='outer-value'}){
  const contents=caseName.startsWith('nested')?h('main',null,h(Contents)):h(Contents)
  const child=caseName.startsWith('document')?
    h('html',null,h('head',null,h('title',null,'Context probe')),h('body',null,contents)):contents
  return h(outer.Provider,{value},child)
}
const container=caseName.startsWith('document')?document:document.getElementById('root')
root=hydrateRoot(container,h(App),{
  onRecoverableError:error=>errors.recoverable.push(String(error)),
  onUncaughtError:error=>errors.uncaught.push(String(error)),
  onCaughtError:error=>errors.caught.push(String(error)),
})
globalThis.__contextProbe={
  read(){return {text:document.getElementById('consumer')?.textContent??null,events:[...events],errors,subscriptions,
    htmlElements:document.querySelectorAll('html').length,bodyElements:document.querySelectorAll('body').length}},
  click(){flushSync(()=>document.getElementById('consumer')?.click())},
  update(){flushSync(()=>root.render(h(App,{value:'outer-updated'})))},
  unmount(){flushSync(()=>root.unmount())},
}
