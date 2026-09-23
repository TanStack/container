import {readFileSync,writeFileSync} from 'node:fs'

export function stageAsyncGeneratorQueue(file){
  let source=readFileSync(file,'utf8')
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected async generator queue integration site')
    source=source.replace(from,to)
  }
  // Completed next/throw requests settle synchronously. Keep draining them;
  // only return(value) needs to pause while its value is awaited.
  replace(`                js_async_generator_reject(ctx, s, next->result);
            }
            goto done;
        case JS_ASYNC_GENERATOR_STATE_SUSPENDED_YIELD:`,
`                js_async_generator_reject(ctx, s, next->result);
            }
            if (s->state == JS_ASYNC_GENERATOR_STATE_AWAITING_RETURN)
                goto done;
            break;
        case JS_ASYNC_GENERATOR_STATE_SUSPENDED_YIELD:`)
  // Settling an awaited return must wake requests queued behind it.
  replace(`            js_async_generator_resolve(ctx, s, arg, TRUE);
        }
    } else {
        /* restart function execution after await() */`,
`            js_async_generator_resolve(ctx, s, arg, TRUE);
        }
        js_async_generator_resume_next(ctx, s);
    } else {
        /* restart function execution after await() */`)
  writeFileSync(file,source)
}
