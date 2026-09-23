// The path implementation uses only virtual process state and guest intrinsics.
const invalid=name=>Object.assign(new TypeError('Invalid '+name),{code:'ERR_INVALID_ARG_TYPE'})
module.exports={
  CHAR_UPPERCASE_A:65,CHAR_LOWERCASE_A:97,CHAR_UPPERCASE_Z:90,CHAR_LOWERCASE_Z:122,
  CHAR_DOT:46,CHAR_FORWARD_SLASH:47,CHAR_BACKWARD_SLASH:92,CHAR_COLON:58,CHAR_QUESTION_MARK:63,
  validateString(value,name){if(typeof value!=='string')throw invalid(name)},
  validateObject(value,name){if(value===null||typeof value!=='object'||Array.isArray(value))throw invalid(name)},
  isWindows:false,
  getLazy(initialize){let value;return ()=>value??=initialize()},
  matchGlobPattern(){throw Object.assign(new Error('path.matchesGlob is not implemented in this sandbox'),{code:'ERR_UNSUPPORTED_OPERATION'})},
}
