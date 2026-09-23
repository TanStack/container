import {readFileSync,writeFileSync} from 'node:fs'

export function stageJobPump(path){
  let source=readFileSync(path,'utf8')
  const original=`    int count = 0, status;
    JSContext *job_ctx;
    while (count < 100) {`
  const replacement=`    int count = 0, status, limit = 100;
    JSContext *job_ctx;
    if (argc > 0) {
        double requested;
        if (JS_ToFloat64(ctx, &requested, argv[0])) return JS_EXCEPTION;
        if (!(requested >= 1 && requested <= 100) || requested != (int)requested)
            return JS_ThrowRangeError(ctx, "Job batch size must be an integer from 1 to 100");
        limit = (int)requested;
    }
    while (count < limit) {`
  if(source.split(original).length!==2)throw Error('Unexpected native job pump source')
  source=source.replace(original,replacement)
  writeFileSync(path,source)
}
