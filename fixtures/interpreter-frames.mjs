export const source=`
const closures=[];let finalized=0;
function descend(n){let value=n;closures.push(()=>++value);try{if(n===0)throw 42;return 1+descend(n-1)}finally{finalized++}}
let thrown;try{descend(700)}catch(error){thrown=error}
const object={base:3,walk(n,value){return n?1+this.walk(n-1,value):this.base+value}};
function args(n){if(n)return 1+args(n-1);arguments[0]=7;return n}
function tail(n){return n?tail(n-1):42}
function sum(n){return n?1+sum(n-1):0}
const before=closures.map(fn=>fn());const after=closures.map(fn=>fn());
return {thrown,finalized,before,after,method:object.walk(700,4),arguments:args(700),tail:tail(2000),sum:sum(2000)};
`
export const spreadSource=`const object={base:3,walk(n,...rest){return n?1+this.walk(n-1,...rest):this.base+rest[0]}};return object.walk(700,4);`
