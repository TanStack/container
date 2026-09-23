import {readFileSync,writeFileSync} from 'node:fs'

// Keep right-associative assignment state in the runtime allocator instead of
// consuming one native parser frame per assignment. Other grammar recursion
// remains unchanged, including logical assignment and destructuring.
export function stageAssignmentParser(path){
  let source=readFileSync(path,'utf8')
  const start=source.indexOf('static __exception int js_parse_assign_expr2(JSParseState *s, int parse_flags)\n{')
  const end=source.indexOf('\nstatic __exception int js_parse_assign_expr(JSParseState *s)',start)
  if(start<0||end<0)throw Error('Missing assignment parser')
  let body=source.slice(start,end)
  const replace=(from,to)=>{
    if(body.split(from).length!==2)throw Error('Unexpected assignment parser patch site')
    body=body.replace(from,to)
  }
  const recursiveStart=body.indexOf('        if (js_parse_assign_expr2(s, parse_flags)) {',body.indexOf("    if (op == '=' ||"))
  const recursiveEnd=body.indexOf('    } else if (op >= TOK_LAND_ASSIGN',recursiveStart)
  if(recursiveStart<0||recursiveEnd<0)throw Error('Missing assignment recursion')
  const finish=body.slice(recursiveStart,recursiveEnd)
  const emission=finish.slice(finish.indexOf("        if (op == '=')"))
  body=body.slice(0,recursiveStart)+`        AssignmentFrame *frame = js_malloc(s->ctx, sizeof(*frame));
        if (!frame) {
            JS_FreeAtom(s->ctx, name);
            return -1;
        }
        frame->previous = assignments;
        frame->opcode = opcode; frame->op = op; frame->scope = scope;
        frame->name = name; frame->name0 = name0;
        frame->label = label; frame->token = op_token_ptr;
        assignments = frame;
        goto assignment_next;
`+body.slice(recursiveEnd)
  // Route every terminal parser branch through the same ownership cleanup.
  body=body.replace(/(^[ \t]*)return\s+([^;]+);/gm,(_,indent,value)=>`${indent}do { result = (${value}); goto assignment_complete; } while (0);`)
  replace('    JSAtom name;\n',`    JSAtom name;
    typedef struct AssignmentFrame {
        struct AssignmentFrame *previous;
        int opcode, op, scope, label;
        JSAtom name, name0;
        const uint8_t *token;
    } AssignmentFrame;
    AssignmentFrame *assignments = NULL;
    int result;
 assignment_next:
    name0 = JS_ATOM_NULL;
`)
  const close=body.lastIndexOf('\n}')
  body=body.slice(0,close)+`
 assignment_complete:
    while (assignments) {
        AssignmentFrame *frame = assignments;
        int label = frame->label;
        const uint8_t *op_token_ptr = frame->token;
        opcode = frame->opcode; op = frame->op; scope = frame->scope;
        name = frame->name; name0 = frame->name0;
        assignments = frame->previous;
        js_free(s->ctx, frame);
        if (result < 0) {
            JS_FreeAtom(s->ctx, name);
            continue;
        }
${emission}
    }
    return result;
`+body.slice(close)
  writeFileSync(path,source.slice(0,start)+body+source.slice(end))
}
