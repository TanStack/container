// Guest intrinsics used by the pinned Node source. No host values are exposed.
const uncurry=fn=>Function.prototype.call.bind(fn)
module.exports={
  Array,ArrayIsArray:Array.isArray,Int8Array,MathAbs:Math.abs,
  ArrayPrototypeIncludes:uncurry(Array.prototype.includes),
  ArrayPrototypeJoin:uncurry(Array.prototype.join),
  ArrayPrototypePush:uncurry(Array.prototype.push),
  ArrayPrototypeSlice:uncurry(Array.prototype.slice),
  FunctionPrototypeBind:uncurry(Function.prototype.bind),
  NumberIsFinite:Number.isFinite,ObjectKeys:Object.keys,String,decodeURIComponent,
  NumberPrototypeToString:uncurry(Number.prototype.toString),
  StringPrototypeCharCodeAt:uncurry(String.prototype.charCodeAt),
  StringPrototypeSlice:uncurry(String.prototype.slice),
  StringPrototypeIncludes:uncurry(String.prototype.includes),
  StringPrototypeIndexOf:uncurry(String.prototype.indexOf),
  StringPrototypeLastIndexOf:uncurry(String.prototype.lastIndexOf),
  StringPrototypeRepeat:uncurry(String.prototype.repeat),
  StringPrototypeReplace:uncurry(String.prototype.replace),
  StringPrototypeSplit:uncurry(String.prototype.split),
  StringPrototypeToLowerCase:uncurry(String.prototype.toLowerCase),
  StringPrototypeToUpperCase:uncurry(String.prototype.toUpperCase),
}
