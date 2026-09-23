const invalid=()=>Object.assign(new TypeError('The "key" argument must be of type string'),{code:'ERR_INVALID_ARG_TYPE'})
const unavailable=()=>Object.assign(new Error('Operation cannot be invoked when not in a single-executable application'),{code:'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION'})
const asset=key=>{if(typeof key!=='string')throw invalid();throw unavailable()}
export const isSea=()=>false
export const getAsset=asset
export const getRawAsset=asset
export const getAssetAsBlob=asset
export const getAssetKeys=()=>{throw unavailable()}
export default {isSea,getAsset,getRawAsset,getAssetAsBlob,getAssetKeys}
