/** A requested stdin read keeps a command alive until EOF or stream closure. */
export class NativeInputLifetime {
  #release:(()=>void)|undefined
  #finished=false
  #paused=false
  #requested=false
  constructor(private keepAlive:()=>()=>void){}
  readRequested(){this.#requested=true;if(!this.#finished&&!this.#paused&&!this.#release)this.#release=this.keepAlive()}
  pause(){this.#paused=true;this.#release?.();this.#release=undefined}
  resume(){this.#paused=false;if(this.#requested)this.readRequested()}
  finish(){this.#finished=true;this.#release?.();this.#release=undefined}
}
