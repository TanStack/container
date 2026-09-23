import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'

export function stageLocalReferenceBoundary(directory){
  const path=join(directory,'m3_compile.c')
  let source=readFileSync(path,'utf8')
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected local-reference compiler site')
    source=source.replace(from,to)
  }
  replace(`M3Result FindReferencedLocalWithinCurrentBlock (IM3Compilation o, u16* o_preservedSlotNumber, u32 i_localSlot)
{
    M3Result result = m3Err_none;

    IM3CompilationScope scope = &o->block;`, `u16 ReferencedLocalStart (IM3Compilation o)
{
    IM3CompilationScope scope = &o->block;`)
  replace(`    *o_preservedSlotNumber = (u16)i_localSlot;

    for (u32 i = startIndex;`, `    return startIndex;
}

static
M3Result FindReferencedLocalFrom (IM3Compilation o, u16* o_preservedSlotNumber, u32 i_localSlot, u16 startIndex)
{
    M3Result result = m3Err_none;
    *o_preservedSlotNumber = (u16)i_localSlot;

    for (u32 i = startIndex;`)
  replace('static\nM3Result GetBlockScope (', `static
M3Result FindReferencedLocalWithinCurrentBlock (IM3Compilation o, u16* slot, u32 localSlot)
{
    return FindReferencedLocalFrom(o, slot, localSlot, ReferencedLocalStart(o));
}

static
M3Result GetBlockScope (`)
  replace(`        u32 numArgsAndLocals = GetFunctionNumArgsAndLocals(o->function);

        for`, `        u32 numArgsAndLocals = GetFunctionNumArgsAndLocals(o->function);
        /* Preserving locals changes slots, not the enclosing block boundary. */
        u16 referenceStart = ReferencedLocalStart(o);

        for`)
  replace('FindReferencedLocalWithinCurrentBlock(o, &preservedSlotNumber, slot)',
    'FindReferencedLocalFrom(o, &preservedSlotNumber, slot, referenceStart)')
  writeFileSync(path,source)
}
