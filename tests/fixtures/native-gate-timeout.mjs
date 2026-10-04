import {test} from 'node:test'
test('deliberately pending gate control',async()=>{
  const timer=setInterval(()=>{},1000)
  try{await new Promise(()=>{})}finally{clearInterval(timer)}
})
