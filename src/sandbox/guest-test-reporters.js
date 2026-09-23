import {Transform} from 'node:stream'

const indent=(value,count)=>' '.repeat(count)+value
const directive=data=>data.skip!==undefined?' # SKIP'+(data.skip===true?'':' '+data.skip):data.todo!==undefined?' # TODO'+(data.todo===true?'':' '+data.todo):''
const diagnostic=data=>indent('# '+data.message+'\n',data.nesting*4)

export async function* tap(source){
  yield 'TAP version 13\n'
  for await(const {type,data} of source){
    const depth=data.nesting*4
    if(type==='test:start')yield indent('# Subtest: '+data.name+'\n',depth)
    else if(type==='test:pass'||type==='test:fail'){
      yield indent((type==='test:fail'?'not ok ':'ok ')+data.testNumber+' - '+data.name+directive(data)+'\n',depth)
      if(data.details){yield indent('  ---\n',depth);for(const [name,value] of Object.entries(data.details)){if(name==='error')continue;yield indent('  '+name+': '+(typeof value==='string'?"'"+value.replaceAll("'","''")+"'":value)+'\n',depth)}if(type==='test:fail'&&data.details.error){const error=data.details.error;yield indent("  location: '"+data.file+':'+data.line+':'+data.column+"'\n",depth);yield indent("  error: '"+String(error.message??error).replaceAll("'","''")+"'\n",depth);if(error.code)yield indent("  code: '"+error.code+"'\n",depth);if(error.stack){yield indent('  stack: |-\n',depth);for(const line of String(error.stack).split('\n').slice(1))yield indent('    '+line.trimStart().replace(/^at /,'')+'\n',depth)}}yield indent('  ...\n',depth)}
    }else if(type==='test:plan')yield indent('1..'+data.count+'\n',depth)
    else if(type==='test:diagnostic')yield diagnostic(data)
    else if(type==='test:stdout'||type==='test:stderr')yield data.message
  }
}

export async function* dot(source){
  let output='';const failed=[]
  for await(const {type,data} of source)if(type==='test:pass'||type==='test:fail'){output+=type==='test:pass'?'.':'X';if(type==='test:fail')failed.push(data)}
  if(output)yield output+'\n'
  if(failed.length){yield '\nFailed tests:\n';for(const data of failed)yield '\n✖ '+data.name+' ('+(data.details?.duration_ms??0)+'ms)\n  '+data.details?.error?.failureType+'\n'}
}

const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')
export async function* junit(source){
  yield '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
  for await(const {type,data} of source){
    if(type==='test:pass'||type==='test:fail'){
      const details=data.details??{},open='\t<testcase name="'+xml(data.name)+'" time="'+((details.duration_ms??0)/1000).toFixed(6)+'" classname="'+xml(details.type??'test')+'" file="'+xml(data.file??'')+'"'
      if(type==='test:fail'){const error=details.error??{},code=error.code??'ERR_TEST_FAILURE',message=error.message??String(error),body=(error.stack??String(error))+(error.code?' {\n  code: \''+String(error.code).replaceAll("'","&apos;")+"'\n}":'');yield open+' failure="'+xml(message)+'">\n\t\t<failure type="'+xml(code)+'" message="'+xml(message)+'">\n'+body+'\n\t\t</failure>\n\t</testcase>\n'}
      else if(data.skip!==undefined)yield open+'>\n\t\t<skipped type="skipped" message="'+xml(data.skip===true?'':data.skip)+'"/>\n\t</testcase>\n'
      else if(data.todo!==undefined)yield open+'>\n\t\t<skipped type="todo" message="'+xml(data.todo===true?'':data.todo)+'"/>\n\t</testcase>\n'
      else yield open+'/>\n'
    }else if(type==='test:diagnostic')yield '\t<!-- '+String(data.message).replaceAll('--','- -')+' -->\n'
  }
  yield '</testsuites>\n'
}

export function spec(){
  const failed=[]
  return new Transform({writableObjectMode:true,transform({type,data},_encoding,done){
    if(type==='test:pass')this.push(data.skip!==undefined?'﹣ '+data.name+' # '+(data.skip===true?'SKIP':data.skip)+'\n':'✔ '+data.name+' ('+(data.details?.duration_ms??0)+'ms)\n')
    else if(type==='test:fail'){failed.push(data);this.push('✖ '+data.name+' ('+(data.details?.duration_ms??0)+'ms)\n')}
    else if(type==='test:diagnostic')this.push('ℹ '+data.message+'\n')
    else if(type==='test:stdout'||type==='test:stderr')this.push(data.message)
    done()
  },flush(done){if(failed.length){this.push('\n✖ failing tests:\n');for(const data of failed)this.push('\ntest at '+data.file+':'+data.line+':'+data.column+'\n✖ '+data.name+' ('+(data.details?.duration_ms??0)+'ms)\n  '+data.details?.error?.failureType+'\n')}done()}})
}

export default {tap,spec,dot,junit}
