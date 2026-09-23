import {readFileSync,writeFileSync} from 'node:fs'

export function sourcePositionCacheSource(input){
  let source=input
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected source-position cache site')
    source=source.replace(from,to)
  }
  replace('    const uint8_t *buf_start;\n} GetLineColCache;',`    const uint8_t *buf_start;
    size_t checkpoint_stride;
    unsigned checkpoint_filled;
    int checkpoint_lines[32];
    int checkpoint_columns[32];
} GetLineColCache;`)
  replace(`static int get_line_col_cached(GetLineColCache *s, int *pcol_num, const uint8_t *ptr)
{
    int line_num, col_num;`, `static int get_line_col_cached(GetLineColCache *s, int *pcol_num, const uint8_t *ptr)
{
    int line_num, col_num;
    size_t offset = ptr - s->buf_start;
    unsigned bucket = offset / s->checkpoint_stride;
    const uint8_t *checkpoint;
    if (bucket >= 32) bucket = 31;
    while (s->checkpoint_filled < bucket) {
        unsigned i = s->checkpoint_filled++;
        int col;
        int lines = get_line_col(&col, s->buf_start + i * s->checkpoint_stride,
                                 s->checkpoint_stride);
        s->checkpoint_lines[i + 1] = s->checkpoint_lines[i] + lines;
        s->checkpoint_columns[i + 1] = lines ? col : s->checkpoint_columns[i] + col;
    }
    checkpoint = s->buf_start + bucket * s->checkpoint_stride;
    /* Retain nearby backward lookups as well as sequential forward lookups. */
    if (s->ptr < checkpoint ||
        (s->ptr > ptr && s->ptr - ptr > ptr - checkpoint)) {
        s->ptr = checkpoint;
        s->line_num = s->checkpoint_lines[bucket];
        s->col_num = s->checkpoint_columns[bucket];
    }`)
  replace('    s->get_line_col_cache.col_num = 0;',`    s->get_line_col_cache.col_num = 0;
    s->get_line_col_cache.checkpoint_stride = input_len / 32 + 1;`)
  return source
}

export function stageSourcePositionCache(path){
  writeFileSync(path,sourcePositionCacheSource(readFileSync(path,'utf8')))
}
