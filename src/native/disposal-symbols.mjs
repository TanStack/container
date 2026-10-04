// Node exposes both resource-management symbols even when its JavaScript
// engine does not provide them. Install them before evaluating handle classes.
export function installNodeDisposalSymbols(symbolConstructor=Symbol){
  for(const name of ['dispose','asyncDispose']){
    if(symbolConstructor[name]===undefined)
      Object.defineProperty(symbolConstructor,name,{value:symbolConstructor('Symbol.'+name)})
  }
}

installNodeDisposalSymbols()
