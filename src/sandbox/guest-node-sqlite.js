const host=globalThis.__webContainerHost
const unsupported=message=>Object.assign(Error(message+' is not supported by the in-memory node:sqlite guest'),{code:'ERR_UNSUPPORTED_OPERATION'})
const closed=()=>Object.assign(Error('Database is closed'),{code:'ERR_INVALID_STATE'})
const options=value=>{if(value===undefined)return;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw unsupported('Database options')}
const parameters=args=>args.length===1&&args[0]&&typeof args[0]==='object'&&!ArrayBuffer.isView(args[0])&&!Array.isArray(args[0])?args[0]:args
export class DatabaseSync {
  constructor(location=':memory:',settings){
    if(location!==':memory:')throw unsupported('File-backed databases')
    options(settings);const SQL=host.preparedBuiltins?.sqlite;if(!SQL)throw Object.assign(Error('SQLite builtin preparation did not complete'),{code:'ERR_INVALID_STATE'})
    this._db=new SQL.Database();this._open=true
  }
  _assert(){if(!this._open)throw closed()}
  exec(sql){this._assert();if(typeof sql!=='string')throw new TypeError('SQL must be a string');this._db.run(sql)}
  prepare(sql){this._assert();if(typeof sql!=='string')throw new TypeError('SQL must be a string');return new StatementSync(this,this._db.prepare(sql))}
  close(){this._assert();this._open=false;this._db.close()}
  createSession(){throw unsupported('Sessions')}
  applyChangeset(){throw unsupported('Sessions')}
  aggregate(){throw unsupported('Aggregate functions')}
  function(){throw unsupported('Extensions and user-defined functions')}
  loadExtension(){throw unsupported('Extensions')}
  enableLoadExtension(){throw unsupported('Extensions')}
}
export class StatementSync {
  constructor(database,statement){this._database=database;this._statement=statement;this._open=true;this._returnArrays=false}
  _assert(){this._database._assert();if(!this._open)throw closed()}
  _bind(args){this._assert();this._statement.reset();this._statement.bind(parameters(args))}
  run(...args){this._bind(args);try{this._statement.step();return {changes:this._database._db.getRowsModified(),lastInsertRowid:this._database._db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0]}}finally{this._statement.reset()}}
  _row(){return this._returnArrays?this._statement.get():this._statement.getAsObject()}
  get(...args){this._bind(args);try{return this._statement.step()?this._row():undefined}finally{this._statement.reset()}}
  all(...args){this._bind(args);try{const rows=[];while(this._statement.step())rows.push(this._row());return rows}finally{this._statement.reset()}}
  iterate(...args){this._bind(args);const statement=this._statement,self=this;return (function*(){try{for(;;){self._assert();if(!statement.step())break;yield self._row()}}finally{if(self._database._open)statement.reset()}})()}
  setAllowBareNamedParameters(){throw unsupported('Statement options')}
  setReadBigInts(){throw unsupported('Statement options')}
  setReturnArrays(enabled){
    if(!this._database._open||!this._open)throw Object.assign(Error('statement has been finalized'),{code:'ERR_INVALID_STATE'})
    if(typeof enabled!=='boolean')throw Object.assign(new TypeError('The "returnArrays" argument must be a boolean.'),{code:'ERR_INVALID_ARG_TYPE'})
    this._returnArrays=enabled
  }
}
export default {DatabaseSync,StatementSync}
