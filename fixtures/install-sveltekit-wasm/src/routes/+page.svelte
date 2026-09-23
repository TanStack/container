<script>
  import {onMount} from 'svelte'
  let {data}=$props()
  let hydrated=$state(false),count=$state(0),reply=$state('')
  onMount(()=>{hydrated=true})
  async function request(){reply=JSON.stringify(await (await fetch('/api',{method:'POST'})).json())}
</script>
<main data-hydrated={hydrated}>
  <h1>Installed SvelteKit</h1>
  <p>{data.message}</p>
  <button id="count" onclick={()=>count++}>Count: {count}</button>
  <button id="request" onclick={request}>Call server</button>
  <output id="reply">{reply}</output>
</main>
