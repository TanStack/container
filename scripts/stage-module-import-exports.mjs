import {readFileSync,writeFileSync} from 'node:fs'

// ResolveExport must find the original live binding during cyclic linking.
export function stageModuleImportExports(path){
  const source=readFileSync(path,'utf8')
  const before=`        if (me->export_type == JS_EXPORT_TYPE_LOCAL) {
            /* local export */
            *pmodule = m;`
  const after=`        if (me->export_type == JS_EXPORT_TYPE_LOCAL) {
            /* Follow named imports before selecting a live binding. A cyclic
               importer must not capture an intermediary's placeholder cell. */
            for (int i = 0; i < m->import_entries_count; i++) {
                ${'JS'+'ImportEntry'} *mi = &m->import_entries[i];
                if (mi->var_idx == me->u.local.var_idx && !mi->is_star) {
                    JSModuleDef *origin = m->req_module_entries[mi->req_module_idx].module;
                    return js_resolve_export1(ctx, pmodule, pme, origin,
                                              mi->import_name, s);
                }
            }
            /* local export */
            *pmodule = m;`
  if(source.split(before).length!==2)throw Error('Unexpected module import/export resolution stage site')
  writeFileSync(path,source.replace(before,after))
}
