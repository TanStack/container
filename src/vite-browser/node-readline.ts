const unavailable=()=>{throw Error('Interactive readline is unavailable in this browser worker')}
export const createInterface=unavailable
export const clearLine=unavailable
export const cursorTo=unavailable
export const moveCursor=unavailable
export default {createInterface,clearLine,cursorTo,moveCursor}
