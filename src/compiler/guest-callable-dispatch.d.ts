export interface GuestCallableCallbackOrigin {operation:number;callback:number}
/** Production transports reserve queued inputs against the same aggregate
 * source budget as active work. start consumes its fifth argument on success;
 * releaseReservation releases an input that never reached start.
 * reserve also rejects live callback-owned reentry before admission waits.
 */
export function createGuestCallableDispatch(transport:any,callbackScope?:{
  run<T>(origin:GuestCallableCallbackOrigin,callback:()=>T):T
  getStore():GuestCallableCallbackOrigin|undefined
}):any
