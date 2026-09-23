// ANSI matcher from Node v24.15.0, lib/internal/util/inspect.js.
// Node's license is retained in src/compiler/vendor/node24/LICENSE.
const ansi = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);
const replaceVT=Function.prototype.call.bind(RegExp.prototype[Symbol.replace]);
export function stripVTControlCharacters(value){
  if(typeof value!=='string')throw Object.assign(new TypeError('Expected a string'),{code:'ERR_INVALID_ARG_TYPE'});
  return replaceVT(ansi,value,'');
}
