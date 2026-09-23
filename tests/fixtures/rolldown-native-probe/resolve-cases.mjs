export const files={
  'package.json':JSON.stringify({name:'resolver-reference',type:'module',imports:{'#local':'./src/imported.js'}}),
  'src/main.js':'export const main = true',
  'src/relative.js':'export default "relative"',
  'src/imported.js':'export default "imports"',
  'node_modules/reference-pkg/package.json':JSON.stringify({name:'reference-pkg',type:'module',exports:{'.':'./index.js','./feature':'./feature.js'}}),
  'node_modules/reference-pkg/index.js':'export default "package"',
  'node_modules/reference-pkg/feature.js':'export default "feature"',
  'node_modules/reference-pkg/updated.js':'export default "updated feature"',
  'packages/linked/package.json':JSON.stringify({name:'linked',type:'module',exports:'./index.js'}),
  'packages/linked/index.js':'export default "linked"',
}
export const symlinks={'node_modules/linked':'../packages/linked'}
export const updateCase={path:'node_modules/reference-pkg/package.json',source:JSON.stringify({name:'reference-pkg',type:'module',exports:{'.':'./index.js','./feature':'./updated.js'}}),specifier:'reference-pkg/feature',before:'node_modules/reference-pkg/feature.js',after:'node_modules/reference-pkg/updated.js',event:{event:'update'}}
export const cases=[
  {name:'relative',specifier:'./relative.js',expected:'src/relative.js'},
  {name:'package',specifier:'reference-pkg',expected:'node_modules/reference-pkg/index.js'},
  {name:'exports',specifier:'reference-pkg/feature',expected:'node_modules/reference-pkg/feature.js'},
  {name:'imports',specifier:'#local',expected:'src/imported.js'},
  {name:'symlink',specifier:'linked',expected:'packages/linked/index.js'},
]
/** Exact observed descriptor fields for this owned Vite8.3 client fixture. */
export function descriptor(root,resolveSubpathImports,onWarn){return {__name:'builtin:vite-resolve',options:{
  tsconfig:undefined,
  resolveOptions:{isBuild:false,isProduction:false,asSrc:true,preferRelative:false,isRequire:undefined,root,scan:false,mainFields:['browser','module','jsnext:main','jsnext','main'],conditions:['module','browser','development|production'],externalConditions:['node','module-sync'],extensions:['.mjs','.js','.mts','.ts','.jsx','.tsx','.json'],tryIndex:true,tryPrefix:undefined,preserveSymlinks:false,tsconfigPaths:false},
  environmentConsumer:'client',environmentName:'client',builtins:[],external:[],noExternal:[],dedupe:[],disableCache:true,legacyInconsistentCjsInterop:undefined,finalizeBareSpecifier:undefined,finalizeOtherSpecifiers:undefined,resolveSubpathImports,onWarn,yarnPnp:false,
}}}
